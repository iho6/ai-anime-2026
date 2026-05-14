"""Hunyuan Video 1.5 image-to-video (720p API easyCache): patch workflow, one job per input image."""

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

API_KEY = "video_hunyuan_video_1.5_720p_i2v_api_easyCache"
DEFAULT_LENGTH = 33
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 1280


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


def _find_hunyuan_i2v_nodes(workflow: dict[str, Any]) -> tuple[str, str]:
    hun_nid: str | None = None
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") == "HunyuanVideo15ImageToVideo":
            hun_nid = str(nid)
            break
    if not hun_nid:
        raise ValueError("Workflow has no HunyuanVideo15ImageToVideo node")

    inp = workflow[hun_nid].get("inputs") or {}
    start_ref = inp.get("start_image")
    if not (isinstance(start_ref, list) and len(start_ref) >= 1):
        raise ValueError("HunyuanVideo15ImageToVideo missing start_image link")
    load_nid = str(start_ref[0])
    n = workflow.get(load_nid)
    if not isinstance(n, dict) or n.get("class_type") != "LoadImage":
        raise ValueError(f"Expected LoadImage at node {load_nid}")
    return hun_nid, load_nid


def _find_clip_encode_by_title_contains(
    workflow: dict[str, Any], *, needle: str
) -> str | None:
    needle_l = needle.lower()
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "CLIPTextEncode":
            continue
        meta = node.get("_meta") or {}
        title = str(meta.get("title") or "").lower()
        if needle_l in title and "text" in (node.get("inputs") or {}):
            return str(nid)
    return None


def _find_first_node_id(workflow: dict[str, Any], class_type: str) -> str | None:
    for nid, node in workflow.items():
        if isinstance(node, dict) and node.get("class_type") == class_type:
            return str(nid)
    return None


def _patch_workflow(
    api_workflow: dict[str, Any],
    *,
    image_ref: str,
    width: int,
    height: int,
    length: int,
    positive_prompt: str | None,
    negative_prompt: str | None,
    steps: int | None,
    cfg: float | None,
    seed: int | None,
    fps: int | None,
) -> dict[str, Any]:
    w = deepcopy(api_workflow)
    hun_nid, load_nid = _find_hunyuan_i2v_nodes(w)

    img = str(image_ref).strip()
    if osp.isfile(img):
        img = osp.basename(img)
    w[load_nid].setdefault("inputs", {})["image"] = img

    hun_in = w[hun_nid].setdefault("inputs", {})
    hun_in["width"] = int(width)
    hun_in["height"] = int(height)
    hun_in["length"] = int(length)

    pos_nid = _find_clip_encode_by_title_contains(w, needle="positive")
    if pos_nid and positive_prompt is not None:
        w[pos_nid].setdefault("inputs", {})["text"] = str(positive_prompt)

    neg_nid = _find_clip_encode_by_title_contains(w, needle="negative")
    if neg_nid and negative_prompt is not None:
        w[neg_nid].setdefault("inputs", {})["text"] = str(negative_prompt)

    sched = _find_first_node_id(w, "BasicScheduler")
    if sched and steps is not None:
        w[sched].setdefault("inputs", {})["steps"] = int(steps)

    guider = _find_first_node_id(w, "CFGGuider")
    if guider and cfg is not None:
        w[guider].setdefault("inputs", {})["cfg"] = float(cfg)

    noise = _find_first_node_id(w, "RandomNoise")
    if noise and seed is not None:
        w[noise].setdefault("inputs", {})["noise_seed"] = int(seed)

    create_vid = _find_first_node_id(w, "CreateVideo")
    if create_vid and fps is not None:
        w[create_vid].setdefault("inputs", {})["fps"] = int(fps)

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


def align_lengths_for_images(
    lengths: list[int] | None, n_jobs: int, *, default: int = DEFAULT_LENGTH
) -> list[int]:
    raw = list(lengths) if lengths else []
    if n_jobs <= 0:
        return []
    if len(raw) == n_jobs:
        return raw
    if len(raw) > n_jobs:
        logger.warning(
            "Got %d length value(s) for %d image(s); using the first %d.",
            len(raw),
            n_jobs,
            n_jobs,
        )
        return raw[:n_jobs]
    logger.warning(
        "Got %d length value(s) for %d image(s); padding remaining with %s.",
        len(raw),
        n_jobs,
        raw[-1] if raw else default,
    )
    out = list(raw)
    fill = raw[-1] if raw else default
    while len(out) < n_jobs:
        out.append(fill)
    return out


def _parse_optional_int(task: dict, key: str) -> int | None:
    if key not in task:
        return None
    v = task[key]
    if v is None or (isinstance(v, str) and not str(v).strip()):
        return None
    return int(v)


def _parse_optional_float(task: dict, key: str) -> float | None:
    if key not in task:
        return None
    v = task[key]
    if v is None or (isinstance(v, str) and not str(v).strip()):
        return None
    return float(v)


def run_img2video_job(
    task: dict,
    *,
    workflows: dict[str, Any],
    server_address: str,
    individual_frames: bool = False,
) -> dict[str, Any]:
    out: dict[str, Any] = {"results": []}
    try:
        image_urls = normalize_image_urls(task)
        n_img = len(image_urls)
        if n_img < 1:
            raise ValueError("At least one image is required")

        lengths_in = _parse_lengths(task)
        lengths = align_lengths_for_images(lengths_in, n_img, default=DEFAULT_LENGTH)

        width = _parse_optional_int(task, "width")
        height = _parse_optional_int(task, "height")
        w_px = int(width) if width is not None else DEFAULT_WIDTH
        h_px = int(height) if height is not None else DEFAULT_HEIGHT

        pos = task.get("positive_prompt")
        if pos is not None:
            pos = str(pos).strip() or None
        neg = task.get("negative_prompt")
        if neg is not None:
            neg = str(neg).strip() or None

        steps = _parse_optional_int(task, "steps")
        cfg = _parse_optional_float(task, "cfg")
        seed = _parse_optional_int(task, "seed")
        fps = _parse_optional_int(task, "fps")

        api = workflows.get(API_KEY)
        if not api:
            raise RuntimeError(
                f"Workflow {API_KEY!r} not loaded; add workflows/{API_KEY}.json"
            )

        for j, url in enumerate(image_urls):
            length = lengths[j]
            logger.info(
                "img2video image_index=%s length=%s width=%s height=%s",
                j,
                length,
                w_px,
                h_px,
            )
            try:
                ref = resolve_to_comfy_input_ref(
                    url,
                    server_address,
                    subfolder="anime2026_img2video_inputs",
                )
            except Exception as e:
                logger.error("Input resolve failed: %s", e)
                out["error"] = f"Failed to resolve image {j}: {e}"
                return out

            w = _patch_workflow(
                api,
                image_ref=ref,
                width=w_px,
                height=h_px,
                length=length,
                positive_prompt=pos,
                negative_prompt=neg,
                steps=steps,
                cfg=cfg,
                seed=seed,
                fps=fps,
            )
            try:
                pid = task_queue(w, server_address)
                waiting_for_results(pid, server_address, timeout_seconds=TIMEOUT)
                history = fetch_comfy_history(server_address, pid)
                local_path = _first_video_output_path(history, pid, LOCAL_OUTPUT_DIR)
                if not local_path:
                    out["error"] = f"No video output for image_index {j}"
                    return out
                if individual_frames:
                    dest_dir = osp.join(
                        LOCAL_OUTPUT_DIR,
                        "img2video_frames",
                        f"img{j}_{uuid.uuid4().hex}",
                    )
                    try:
                        png_paths = _extract_video_frames_to_pngs(local_path, dest_dir)
                    except RuntimeError as e:
                        out["error"] = (
                            f"Frame extraction failed for image_index {j}: {e}"
                        )
                        return out
                    frame_urls = [
                        _view_or_s3_url_for_output_file(p, server_address=server_address)
                        for p in png_paths
                    ]
                    out["results"].append(
                        {
                            "image_index": j,
                            "length": length,
                            "frame_urls": frame_urls,
                        }
                    )
                else:
                    vurl = _view_or_s3_url_for_output_file(
                        local_path, server_address=server_address
                    )
                    out["results"].append(
                        {
                            "image_index": j,
                            "length": length,
                            "url": vurl,
                        }
                    )
            except Exception as e:
                logger.error("image_index %s failed: %s", j, e)
                out["error"] = f"Workflow failed for image_index {j}: {e}"
                return out

        return out
    except ValueError as e:
        out["error"] = str(e)
        return out
    except Exception as e:
        logger.error("Job error: %s", e)
        out["error"] = str(e)
        return out
