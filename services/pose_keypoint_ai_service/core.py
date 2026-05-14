"""SDPose keypoint overlay: ComfyUI workflows for images and video."""

from __future__ import annotations

import json
import logging
import os
import os.path as osp
import uuid
from copy import deepcopy
from typing import Any

import urllib.parse
import urllib.request

from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.utils import (
    normalize_image_urls,
    resolve_to_comfy_input_ref,
    resolve_to_comfy_video_file_ref,
    task_queue,
    upload_to_s3,
    waiting_for_results,
)

logger = logging.getLogger("anime2026_services")

WF_IMAGE = "utility_sdpose_ood_image_to_pose"
WF_VIDEO = "utility_sdpose_ood_video_to_pose_map_api"
WF_VIDEO_FRAMES = "utility_sdpose_ood_video_to_pose_frames_api"

_VIDEO_SUFFIXES = (".mp4", ".webm", ".mov", ".mkv", ".avi")


def _find_node_id_by_class(workflow: dict, class_type: str) -> str | None:
    for nid, node in workflow.items():
        if isinstance(node, dict) and node.get("class_type") == class_type:
            return str(nid)
    return None


def _normalize_comfy_file_ref(ref: str) -> str:
    r = str(ref).strip()
    if osp.isfile(r):
        return osp.basename(r)
    return r


def _collect_output_entries(
    history: dict, prompt_id: str
) -> list[tuple[str, str]]:
    """(subfolder, filename) for each file in history outputs."""
    entries: list[tuple[str, str]] = []
    outputs = (history.get(prompt_id) or {}).get("outputs") or {}
    for _nid, out in outputs.items():
        for im in out.get("images") or []:
            if not isinstance(im, dict):
                continue
            fn = im.get("filename")
            if not fn:
                continue
            sub = str(im.get("subfolder") or "").replace("\\", "/").strip("/")
            entries.append((sub, str(fn)))
    return entries


def _resolve_output_full_path(subfolder: str, filename: str, output_dir: str) -> str:
    if subfolder:
        return osp.join(output_dir, subfolder.replace("/", osp.sep), filename)
    return osp.join(output_dir, filename)


def _urls_for_entries(
    entries: list[tuple[str, str]],
    output_dir: str,
    server_address: str,
    *,
    use_s3: bool,
) -> list[str]:
    urls: list[str] = []
    for sub, fn in entries:
        full = _resolve_output_full_path(sub, fn, output_dir)
        if not osp.isfile(full):
            logger.warning("Missing output file: %s", full)
            continue
        if use_s3:
            urls.append(upload_to_s3(full, str(uuid.uuid4())))
        else:
            urls.append(_view_url_single(sub, fn, server_address))
    return urls


def _view_url_single(
    subfolder: str,
    filename: str,
    server_address: str,
) -> str:
    if subfolder:
        return (
            f"http://{server_address}/view?filename={urllib.parse.quote(filename)}"
            f"&type=output&subfolder={urllib.parse.quote(subfolder)}"
        )
    return f"http://{server_address}/view?filename={urllib.parse.quote(filename)}&type=output"


def _run_workflow_queue(
    workflow: dict,
    server_address: str,
) -> dict:
    pid = task_queue(workflow, server_address)
    waiting_for_results(pid, server_address, timeout_seconds=TIMEOUT)
    with urllib.request.urlopen(f"http://{server_address}/history/{pid}") as resp:
        return json.loads(resp.read().decode("utf-8"))


def run_image_keypoints(
    comfy_image_ref: str,
    api_workflow: dict,
    server_address: str,
    *,
    use_s3: bool,
) -> dict[str, Any]:
    w = deepcopy(api_workflow)
    nid = _find_node_id_by_class(w, "LoadImage")
    if not nid:
        raise RuntimeError("Workflow missing LoadImage node")
    w[nid]["inputs"]["image"] = _normalize_comfy_file_ref(comfy_image_ref)
    history = _run_workflow_queue(w, server_address)
    pid = next(iter(history.keys()), None)
    if not pid:
        raise RuntimeError("Empty history from ComfyUI")
    entries = _collect_output_entries(history, pid)
    if not entries:
        raise RuntimeError("No image outputs in workflow history")
    sub, fn = entries[0]
    full = _resolve_output_full_path(sub, fn, LOCAL_OUTPUT_DIR)
    if not osp.isfile(full):
        raise RuntimeError(f"Output file not found: {full}")
    if use_s3:
        url = upload_to_s3(full, str(uuid.uuid4()))
    else:
        url = _view_url_single(sub, fn, server_address)
    return {"kind": "image", "url": url, "filename": fn, "subfolder": sub}


def run_video_keypoints(
    comfy_video_ref: str,
    api_workflow: dict,
    server_address: str,
    *,
    use_s3: bool,
    export_frames: bool,
) -> dict[str, Any]:
    w = deepcopy(api_workflow)
    nid = _find_node_id_by_class(w, "LoadVideo")
    if not nid:
        raise RuntimeError("Workflow missing LoadVideo node")
    w[nid]["inputs"]["file"] = _normalize_comfy_file_ref(comfy_video_ref)
    history = _run_workflow_queue(w, server_address)
    pid = next(iter(history.keys()), None)
    if not pid:
        raise RuntimeError("Empty history from ComfyUI")
    entries = _collect_output_entries(history, pid)
    if not entries:
        raise RuntimeError("No outputs in workflow history")

    if export_frames:
        entries_sorted = sorted(entries, key=lambda t: (t[0], t[1]))
        urls = _urls_for_entries(
            entries_sorted, LOCAL_OUTPUT_DIR, server_address, use_s3=use_s3
        )
        if not urls:
            raise RuntimeError("No frame output files found on disk")
        return {
            "kind": "frames",
            "urls": urls,
            "frame_count": len(urls),
        }

    video_entry: tuple[str, str] | None = None
    for sub, fn in entries:
        if fn.lower().endswith(_VIDEO_SUFFIXES):
            video_entry = (sub, fn)
            break
    if video_entry is None:
        video_entry = entries[0]
    sub, fn = video_entry
    full = _resolve_output_full_path(sub, fn, LOCAL_OUTPUT_DIR)
    if not osp.isfile(full):
        raise RuntimeError(f"Output video not found: {full}")
    if use_s3:
        url = upload_to_s3(full, str(uuid.uuid4()))
    else:
        url = _view_url_single(sub, fn, server_address)
    return {"kind": "video", "url": url, "filename": fn, "subfolder": sub}


def _task_has_video(task: dict) -> bool:
    v = task.get("video_url")
    if v is None:
        return False
    if isinstance(v, str):
        return bool(v.strip())
    return bool(v)


def _task_has_images(task: dict) -> bool:
    if "image_urls" in task:
        u = task["image_urls"]
        if isinstance(u, str):
            return bool(u.strip())
        return isinstance(u, list) and len(u) > 0
    if "image_url" in task:
        u = task.get("image_url")
        return bool(str(u or "").strip())
    return False


def _export_frames_flag(task: dict) -> bool:
    if task.get("export_frame") is True:
        return True
    if task.get("export_frames") is True:
        return True
    ef = task.get("export_frame")
    if isinstance(ef, str) and ef.strip().lower() in ("1", "true", "yes", "on"):
        return True
    return False


def run_pose_keypoint_job(
    task: dict,
    *,
    service_dir: str,
    workflows: dict[str, Any],
    server_address: str,
) -> dict[str, Any]:
    """
    Task:
      - ``image_url`` / ``image_urls``: run image keypoint workflow per image.
      - ``video_url``: run video workflow; ``export_frame`` / ``export_frames`` for per-frame images.

    Returns ``{ "results": [...], "error": optional str }``.
    """
    _ = service_dir  # reserved for future workflow overrides
    wf_map = workflows
    out: dict[str, Any] = {"results": []}
    use_s3 = (os.environ.get("SERVICES_USE_S3") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "y",
        "on",
    }

    has_v = _task_has_video(task)
    has_i = _task_has_images(task)
    if has_v and has_i:
        out["error"] = "Specify either video_url or image_url/image_urls, not both"
        return out
    if not has_v and not has_i:
        out["error"] = "Missing video_url or image_url/image_urls"
        return out

    try:
        if has_i:
            wf = wf_map.get(WF_IMAGE)
            if not wf:
                out["error"] = f"Workflow {WF_IMAGE!r} not loaded"
                return out
            image_urls = normalize_image_urls(task)
            for idx, image_ref in enumerate(image_urls):
                try:
                    comfy_ref = resolve_to_comfy_input_ref(
                        image_ref,
                        server_address,
                        subfolder="anime2026_pose_keypoint_inputs",
                    )
                    item = run_image_keypoints(
                        comfy_ref,
                        wf,
                        server_address,
                        use_s3=use_s3,
                    )
                    item["input_index"] = idx
                    item["source"] = image_ref
                    out["results"].append(item)
                except Exception as e:
                    logger.error("Image keypoint failed index=%s: %s", idx, e)
                    out["error"] = f"Image {idx}: {e}"
                    return out
            return out

        video_ref = str(task.get("video_url") or "").strip()
        export_frames = _export_frames_flag(task)
        wf_name = WF_VIDEO_FRAMES if export_frames else WF_VIDEO
        wf = wf_map.get(wf_name)
        if not wf:
            out["error"] = f"Workflow {wf_name!r} not loaded"
            return out
        comfy_v = resolve_to_comfy_video_file_ref(
            video_ref,
            server_address,
            subfolder="anime2026_pose_keypoint_video_inputs",
        )
        item = run_video_keypoints(
            comfy_v,
            wf,
            server_address,
            use_s3=use_s3,
            export_frames=export_frames,
        )
        item["source"] = video_ref
        out["results"].append(item)
        return out
    except ValueError as e:
        out["error"] = str(e)
        return out
    except Exception as e:
        logger.error("pose_keypoint job: %s", e)
        out["error"] = str(e)
        return out
