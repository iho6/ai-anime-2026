"""Wan first-last-frame-to-video (lightning API): patch workflow and queue one job per frame pair."""

from __future__ import annotations

import logging
import os
import os.path as osp
import uuid
from copy import deepcopy
from typing import Any

import av
import urllib.parse
from PIL import Image

from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.utils import (
    fetch_comfy_history,
    normalize_image_urls,
    resolve_to_comfy_input_ref,
    task_queue,
    upload_to_s3,
    waiting_for_results,
)

logger = logging.getLogger("anime2026_services")

API_KEY = "video_wan2_2_14B_flf2v_lightning_api"
DEFAULT_LENGTH = 33


def _services_use_s3() -> bool:
    return (os.environ.get("SERVICES_USE_S3") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "y",
        "on",
    }


def _view_or_s3_url_for_output_file(
    local_file_path: str,
    *,
    server_address: str,
) -> str:
    """Build Comfy /view URL or S3 URL for a file under LOCAL_OUTPUT_DIR."""
    out_dir = osp.normpath(LOCAL_OUTPUT_DIR)
    parent = osp.normpath(osp.dirname(local_file_path))
    subfolder = ""
    if parent != out_dir:
        subfolder = osp.relpath(parent, out_dir).replace("\\", "/")
    view_name = osp.basename(local_file_path)
    if _services_use_s3():
        return upload_to_s3(local_file_path, str(uuid.uuid4()))
    q: dict[str, str] = {"filename": view_name, "type": "output"}
    if subfolder:
        q["subfolder"] = subfolder
    return f"http://{server_address}/view?{urllib.parse.urlencode(q)}"


def _extract_video_frames_to_pngs(video_path: str, dest_dir: str) -> list[str]:
    """
    Decode every video frame to PNGs (frame_000001.png, …) under dest_dir.
    Returns ordered absolute paths.
    """
    os.makedirs(dest_dir, exist_ok=True)
    paths: list[str] = []
    try:
        with av.open(video_path) as container:
            if not container.streams.video:
                raise RuntimeError("no video stream in output file")
            stream = container.streams.video[0]
            stream.thread_type = "AUTO"
            for i, frame in enumerate(container.decode(stream)):
                arr = frame.to_ndarray(format="rgb24")
                im = Image.fromarray(arr)
                out_path = osp.join(dest_dir, f"frame_{i + 1:06d}.png")
                im.save(out_path)
                paths.append(osp.abspath(out_path))
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"video frame extraction failed: {e}") from e
    if not paths:
        raise RuntimeError("video decode produced zero frames")
    return paths


def _find_wan_flf_nodes(workflow: dict[str, Any]) -> tuple[str, str, str]:
    """Return (wan_node_id, start_load_image_id, end_load_image_id)."""
    wan_nid: str | None = None
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") == "WanFirstLastFrameToVideo":
            wan_nid = nid
            break
    if not wan_nid:
        raise ValueError("Workflow has no WanFirstLastFrameToVideo node")

    inp = workflow[wan_nid].get("inputs") or {}
    start_ref = inp.get("start_image")
    end_ref = inp.get("end_image")
    if not (isinstance(start_ref, list) and len(start_ref) >= 1):
        raise ValueError("WanFirstLastFrameToVideo missing start_image link")
    if not (isinstance(end_ref, list) and len(end_ref) >= 1):
        raise ValueError("WanFirstLastFrameToVideo missing end_image link")
    start_nid = str(start_ref[0])
    end_nid = str(end_ref[0])

    for lid in (start_nid, end_nid):
        n = workflow.get(lid)
        if not isinstance(n, dict) or n.get("class_type") != "LoadImage":
            raise ValueError(f"Expected LoadImage at node {lid}")

    return wan_nid, start_nid, end_nid


def _patch_workflow(
    api_workflow: dict[str, Any],
    *,
    start_ref: str,
    end_ref: str,
    length: int,
    positive_prompt: str | None,
) -> dict[str, Any]:
    w = deepcopy(api_workflow)
    wan_nid, start_nid, end_nid = _find_wan_flf_nodes(w)

    s = str(start_ref).strip()
    e = str(end_ref).strip()
    if osp.isfile(s):
        s = osp.basename(s)
    if osp.isfile(e):
        e = osp.basename(e)
    w[start_nid].setdefault("inputs", {})["image"] = s
    w[end_nid].setdefault("inputs", {})["image"] = e
    w[wan_nid].setdefault("inputs", {})["length"] = int(length)

    if positive_prompt is not None and str(positive_prompt).strip():
        text = str(positive_prompt).strip()
        for _nid, node in w.items():
            if not isinstance(node, dict):
                continue
            if node.get("class_type") != "CLIPTextEncode":
                continue
            meta = node.get("_meta") or {}
            title = str(meta.get("title") or "")
            inputs = node.setdefault("inputs", {})
            if "Positive" in title and "text" in inputs:
                inputs["text"] = text
                break

    return w


def _media_item_path(output_dir: str, item: dict[str, Any]) -> str | None:
    fn = item.get("filename")
    if not fn:
        return None
    sub = (item.get("subfolder") or "").strip().replace("\\", "/").strip("/")
    base = output_dir
    if sub:
        base = osp.join(base, *sub.split("/"))
    path = osp.join(base, str(fn))
    return path if osp.isfile(path) else None


def _first_video_output_path(history: dict, prompt_id: str, output_dir: str) -> str | None:
    block = history.get(prompt_id) or {}
    outputs = block.get("outputs") or {}
    for _nid, out in outputs.items():
        if not isinstance(out, dict):
            continue
        for key in ("gifs", "videos", "images"):
            arr = out.get(key)
            if not isinstance(arr, list):
                continue
            for item in arr:
                if not isinstance(item, dict):
                    continue
                p = _media_item_path(output_dir, item)
                if p:
                    return p
    return None


def _parse_frames_1based(task: dict) -> list[int]:
    raw = task.get("frames")
    if raw is None:
        raise ValueError(
            'Missing "frames": list of 1-based indices into image_urls (at least 2)'
        )
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.replace(",", " ").split() if p.strip()]
        frames = [int(p) for p in parts]
    elif isinstance(raw, list):
        frames = [int(x) for x in raw]
    else:
        raise ValueError("frames must be a list of integers or a comma-separated string")
    if len(frames) < 2:
        raise ValueError("frames must contain at least two indices for first/last pairing")
    return frames


def _parse_lengths(task: dict) -> list[int] | None:
    raw = task.get("lengths")
    if raw is None:
        single = task.get("length")
        if single is not None:
            return [int(single)]
        return None
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.replace(",", " ").split() if p.strip()]
        return [int(p) for p in parts]
    if isinstance(raw, list):
        return [int(x) for x in raw]
    raise ValueError("lengths must be a list of integers or comma-separated string")


def align_lengths_for_pairs(
    lengths: list[int] | None, n_pairs: int, *, default: int = DEFAULT_LENGTH
) -> list[int]:
    raw = list(lengths) if lengths else []
    if n_pairs <= 0:
        return []

    if len(raw) == n_pairs:
        return raw

    if len(raw) > n_pairs:
        logger.warning(
            "Got %d length value(s) for %d first-last pair(s); using the first %d.",
            len(raw),
            n_pairs,
            n_pairs,
        )
        return raw[:n_pairs]

    logger.warning(
        "Got %d length value(s) for %d first-last pair(s); padding remaining with %s.",
        len(raw),
        n_pairs,
        raw[-1] if raw else default,
    )
    out = list(raw)
    fill = raw[-1] if raw else default
    while len(out) < n_pairs:
        out.append(fill)
    return out


def consecutive_pairs_from_frames(
    frames_1based: list[int], n_images: int
) -> list[tuple[int, int, int]]:
    """
    frames_1based: 1-based indices into image_urls.
    Returns (pair_index, url_index_a_0based, url_index_b_0based).
    """
    pairs: list[tuple[int, int, int]] = []
    for i in range(len(frames_1based) - 1):
        a1 = frames_1based[i]
        b1 = frames_1based[i + 1]
        if a1 < 1 or a1 > n_images or b1 < 1 or b1 > n_images:
            raise ValueError(
                f"frame index out of range: got {a1}, {b1} for {n_images} image(s) (1-based)"
            )
        pairs.append((i, a1 - 1, b1 - 1))
    return pairs


def run_flf2video_job(
    task: dict,
    *,
    workflows: dict[str, Any],
    server_address: str,
    individual_frames: bool = False,
) -> dict[str, Any]:
    """
    Returns { "results": [ ... ], "error"? }.

    Each result normally includes ``url`` (single video). When ``individual_frames``
    is True, each result includes ``frame_urls`` (ordered PNGs) and no ``url``.
    """
    out: dict[str, Any] = {"results": []}
    try:
        image_urls = normalize_image_urls(task)
        n_img = len(image_urls)
        frames_1 = _parse_frames_1based(task)
        pairs_meta = consecutive_pairs_from_frames(frames_1, n_img)
        n_pairs = len(pairs_meta)

        lengths_in = _parse_lengths(task)
        lengths = align_lengths_for_pairs(lengths_in, n_pairs, default=DEFAULT_LENGTH)

        api = workflows.get(API_KEY)
        if not api:
            raise RuntimeError(
                f"Workflow {API_KEY!r} not loaded; add workflows/{API_KEY}.json"
            )

        pos = task.get("positive_prompt")
        if pos is not None:
            pos = str(pos).strip() or None

        for j, (_pair_idx, ia, ib) in enumerate(pairs_meta):
            length = lengths[j]
            url_a = image_urls[ia]
            url_b = image_urls[ib]
            logger.info(
                "FLF2V pair %s: frame indices %s-%s (1-based), length=%s",
                j,
                frames_1[j],
                frames_1[j + 1],
                length,
            )
            try:
                ref_start = resolve_to_comfy_input_ref(
                    url_a,
                    server_address,
                    subfolder="anime2026_flf2video_inputs",
                )
                ref_end = resolve_to_comfy_input_ref(
                    url_b,
                    server_address,
                    subfolder="anime2026_flf2video_inputs",
                )
            except Exception as e:
                logger.error("Input resolve failed: %s", e)
                out["error"] = f"Failed to resolve images for pair {j}: {e}"
                return out

            w = _patch_workflow(
                api,
                start_ref=ref_start,
                end_ref=ref_end,
                length=length,
                positive_prompt=pos,
            )
            try:
                pid = task_queue(w, server_address)
                waiting_for_results(pid, server_address, timeout_seconds=TIMEOUT)
                history = fetch_comfy_history(server_address, pid)
                local_path = _first_video_output_path(history, pid, LOCAL_OUTPUT_DIR)
                if not local_path:
                    out["error"] = (
                        f"No video output for pair {j} (frames {frames_1[j]}-{frames_1[j+1]})"
                    )
                    return out
                if individual_frames:
                    dest_dir = osp.join(
                        LOCAL_OUTPUT_DIR,
                        "flf2video_frames",
                        f"pair{j}_{uuid.uuid4().hex}",
                    )
                    try:
                        png_paths = _extract_video_frames_to_pngs(local_path, dest_dir)
                    except RuntimeError as e:
                        out["error"] = (
                            f"Frame extraction failed for pair {j} "
                            f"(frames {frames_1[j]}-{frames_1[j + 1]}): {e}"
                        )
                        return out
                    frame_urls = [
                        _view_or_s3_url_for_output_file(p, server_address=server_address)
                        for p in png_paths
                    ]
                    out["results"].append(
                        {
                            "pair_index": j,
                            "frame_start": frames_1[j],
                            "frame_end": frames_1[j + 1],
                            "length": length,
                            "frame_urls": frame_urls,
                        }
                    )
                else:
                    url = _view_or_s3_url_for_output_file(
                        local_path, server_address=server_address
                    )
                    out["results"].append(
                        {
                            "pair_index": j,
                            "frame_start": frames_1[j],
                            "frame_end": frames_1[j + 1],
                            "length": length,
                            "url": url,
                        }
                    )
            except Exception as e:
                logger.error("Pair %s failed: %s", j, e)
                out["error"] = f"Workflow failed for pair {j}: {e}"
                return out

        return out
    except ValueError as e:
        out["error"] = str(e)
        return out
    except Exception as e:
        logger.error("Job error: %s", e)
        out["error"] = str(e)
        return out
