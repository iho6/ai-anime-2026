"""
SAM 3.1 segmentation (points and/or text) — RunPod serverless + local --test-mode.

Jobs: image_mask (preview), image_rgba (PNG cutout), video_masks (per-frame masks).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import os.path as osp
import re
import sys
import time
import uuid
import urllib.parse
from copy import deepcopy
from typing import Any

try:
    import runpod  # type: ignore
except ModuleNotFoundError:
    runpod = None  # type: ignore

from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.utils import (
    apply_convert_local_paths_to_urls_in_task,
    apply_upload_local_paths_to_comfy_in_task,
    delete_s3_object,
    fetch_comfy_history,
    gpu_preflight,
    load_download_cache,
    load_workflows,
    resolve_to_comfy_input_ref,
    services_use_s3,
    task_queue,
    timing_decorator,
    upload_to_s3,
    waiting_for_results,
    wait_for_service_ready,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d - %(levelname)s - %(message)s",
)
logger = logging.getLogger("anime2026_services")

_SERVICE_DIR = osp.dirname(osp.abspath(__file__))
workflows = load_workflows(osp.join(_SERVICE_DIR, "workflows"))
logger.info("Loaded %s workflow(s): %s", len(workflows), list(workflows.keys()))

local_servers: dict[str, str] = {}
supported_tasks: list = []
convert_local_to_url = False

_KEY_MASK = "sam3_image_mask_api"
_KEY_RGBA = "sam3_image_rgba_api"
_KEY_VIDEO = "sam3_video_masks_api"


def _normalize_text_prompt(raw: str | None) -> str:
    return (raw or "").strip()


def _validate_sam3_prompts(pos: list[Any], text: str) -> None:
    if not pos and not text:
        raise ValueError("Provide at least one positive point or a text prompt.")


def _patch_sam3_text(workflow: dict[str, Any], text: str) -> None:
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") == "CLIPTextEncode":
            node.setdefault("inputs", {})["text"] = text


def _coords_to_json(coords: list[dict[str, Any]] | None) -> str:
    out: list[dict[str, int]] = []
    for pt in coords or []:
        if not isinstance(pt, dict):
            continue
        try:
            x = int(pt.get("x", 0))
            y = int(pt.get("y", 0))
        except (TypeError, ValueError):
            continue
        out.append({"x": x, "y": y})
    return json.dumps(out)


def _patch_sam3_detect(
    workflow: dict[str, Any],
    *,
    positive_coords: str,
    negative_coords: str,
    sam3_options: dict[str, Any] | None = None,
) -> None:
    opts = sam3_options or {}
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "SAM3_Detect":
            continue
        inp = node.setdefault("inputs", {})
        inp["positive_coords"] = positive_coords
        inp["negative_coords"] = negative_coords
        if "threshold" in opts:
            inp["threshold"] = float(opts["threshold"])
        if "refine_iterations" in opts:
            inp["refine_iterations"] = int(opts["refine_iterations"])


def _patch_sam3_video_track(
    workflow: dict[str, Any],
    *,
    sam3_options: dict[str, Any] | None = None,
) -> None:
    opts = sam3_options or {}
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "SAM3_VideoTrack":
            continue
        inp = node.setdefault("inputs", {})
        if "detection_threshold" in opts:
            inp["detection_threshold"] = float(opts["detection_threshold"])


def _patch_image_workflow(
    workflow: dict[str, Any],
    *,
    image_input_ref: str,
    positive_coords: str,
    negative_coords: str,
    text_prompt: str = "",
    sam3_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    w = deepcopy(workflow)
    for nid, node in w.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") == "LoadImage":
            node.setdefault("inputs", {})["image"] = image_input_ref
    _patch_sam3_detect(
        w,
        positive_coords=positive_coords,
        negative_coords=negative_coords,
        sam3_options=sam3_options,
    )
    _patch_sam3_text(w, text_prompt)
    return w


def _patch_video_workflow(
    workflow: dict[str, Any],
    *,
    video_input_ref: str,
    ref_frame_index: int,
    positive_coords: str,
    negative_coords: str,
    text_prompt: str = "",
    sam3_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    w = deepcopy(workflow)
    for node in w.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        if ct == "LoadVideo":
            node.setdefault("inputs", {})["file"] = video_input_ref
        elif ct == "ImageFromBatch":
            node.setdefault("inputs", {})["batch_index"] = max(0, int(ref_frame_index))
    _patch_sam3_detect(
        w,
        positive_coords=positive_coords,
        negative_coords=negative_coords,
        sam3_options=sam3_options,
    )
    _patch_sam3_video_track(w, sam3_options=sam3_options)
    _patch_sam3_text(w, text_prompt)
    return w


def _output_image_entries(history: dict, prompt_id: str, output_dir: str) -> list[dict]:
    outputs = (history.get(prompt_id) or {}).get("outputs") or {}
    entries: list[dict] = []
    for _nid, out in outputs.items():
        for img in out.get("images") or []:
            fn = img.get("filename")
            if not fn:
                continue
            sub = img.get("subfolder") or ""
            local = osp.join(output_dir, sub, fn) if sub else osp.join(output_dir, fn)
            if osp.isfile(local):
                entries.append({"filename": fn, "subfolder": sub, "local": local})
    entries.sort(key=lambda e: e["filename"])
    return entries


def _mask_frame_sort_key(filename: str) -> tuple:
    m = re.search(r"(\d+)", filename)
    return (int(m.group(1)) if m else 0, filename)


def _collect_mask_frame_paths(history: dict, prompt_id: str, output_dir: str) -> list[str]:
    entries = _output_image_entries(history, prompt_id, output_dir)
    entries.sort(key=lambda e: _mask_frame_sort_key(e["filename"]))
    return [e["local"] for e in entries]


def _url_for_local_output(addr: str, local_path: str, output_dir: str) -> str:
    rel = osp.relpath(local_path, output_dir)
    parts = rel.replace("\\", "/").split("/")
    if len(parts) == 1:
        qfn = urllib.parse.quote(parts[0])
        return f"http://{addr}/view?filename={qfn}&type=output"
    sub = urllib.parse.quote("/".join(parts[:-1]))
    qfn = urllib.parse.quote(parts[-1])
    return f"http://{addr}/view?filename={qfn}&subfolder={sub}&type=output"


def _run_workflow(
    workflow: dict[str, Any],
    server_address: str,
) -> tuple[str, list[str]]:
    prompt_id = task_queue(workflow, server_address)
    waiting_for_results(prompt_id, server_address, timeout_seconds=TIMEOUT)
    history = fetch_comfy_history(server_address, prompt_id)
    paths = _collect_mask_frame_paths(history, prompt_id, LOCAL_OUTPUT_DIR)
    if not paths:
        raise RuntimeError("SAM3 workflow completed but produced no output images.")
    return prompt_id, paths


def _prompt_from_task(task: dict) -> tuple[str, str, str]:
    pos = task.get("positive_coords")
    neg = task.get("negative_coords")
    if pos is None:
        pos = task.get("positiveCoords")
    if neg is None:
        neg = task.get("negativeCoords")
    if pos is None:
        pos = []
    if not isinstance(pos, list):
        raise ValueError("positive_coords must be a list when provided.")
    if neg is not None and not isinstance(neg, list):
        raise ValueError("negative_coords must be a list when provided.")
    text = _normalize_text_prompt(
        task.get("text_prompt") or task.get("textPrompt")
    )
    _validate_sam3_prompts(pos, text)
    return _coords_to_json(pos), _coords_to_json(neg or []), text


@timing_decorator
def handler(job_input: dict) -> dict:
    now = int(time.time())
    response: dict = {
        "created_at": now,
        "queued_at": now,
        "error": None,
        "result": None,
        "mask_urls": None,
    }
    staging_s3_keys: list[tuple[str, str]] = []

    try:
        task = job_input.get("input")
        if not isinstance(task, dict):
            response["error"] = "Missing or invalid job input"
            return response

        job = (task.get("job") or "image_mask").strip().lower()
        pos_json, neg_json, text_prompt = _prompt_from_task(task)
        sam3_raw = task.get("sam3_options") or task.get("sam3Options")
        sam3_options: dict[str, Any] | None = None
        if isinstance(sam3_raw, dict):
            sam3_options = dict(sam3_raw)

        gpu_err, gpu_detail = gpu_preflight()
        if gpu_err:
            response["error"] = gpu_err
            return response
        logger.info("[gpu-preflight] OK (%s)", gpu_detail)

        if convert_local_to_url:
            staging_s3_keys = apply_convert_local_paths_to_urls_in_task(task)

        addr = local_servers.get("default", "127.0.0.1:8188")

        if job in ("image_mask", "image_rgba"):
            image_url = (task.get("image_url") or task.get("imageUrl") or "").strip()
            if not image_url:
                response["error"] = "image_url is required"
                return response
            comfy_ref = resolve_to_comfy_input_ref(
                image_url, addr, subfolder="anime2026_sam3_inputs"
            )
            key = _KEY_RGBA if job == "image_rgba" else _KEY_MASK
            api = workflows.get(key)
            if not api:
                response["error"] = f"Missing workflow {key!r}"
                return response
            w = _patch_image_workflow(
                api,
                image_input_ref=(
                    osp.basename(comfy_ref)
                    if osp.isfile(comfy_ref)
                    else str(comfy_ref).strip()
                ),
                positive_coords=pos_json,
                negative_coords=neg_json,
                text_prompt=text_prompt,
                sam3_options=sam3_options,
            )
            _pid, paths = _run_workflow(w, addr)
            urls: list[str] = []
            for p in paths:
                if services_use_s3():
                    urls.append(upload_to_s3(p, str(uuid.uuid4())))
                else:
                    urls.append(_url_for_local_output(addr, p, LOCAL_OUTPUT_DIR))
            response["mask_urls"] = urls
            response["result"] = {"url": urls[0], "urls": urls}
            return response

        if job == "video_masks":
            video_url = (task.get("video_url") or task.get("videoUrl") or "").strip()
            if not video_url:
                response["error"] = "video_url is required"
                return response
            ref_idx = int(task.get("ref_frame_index") or task.get("refFrameIndex") or 0)
            comfy_ref = resolve_to_comfy_input_ref(
                video_url, addr, subfolder="anime2026_sam3_video_inputs"
            )
            api = workflows.get(_KEY_VIDEO)
            if not api:
                response["error"] = f"Missing workflow {_KEY_VIDEO!r}"
                return response
            w = _patch_video_workflow(
                api,
                video_input_ref=(
                    osp.basename(comfy_ref)
                    if osp.isfile(comfy_ref)
                    else str(comfy_ref).strip()
                ),
                ref_frame_index=ref_idx,
                positive_coords=pos_json,
                negative_coords=neg_json,
                text_prompt=text_prompt,
                sam3_options=sam3_options,
            )
            _pid, paths = _run_workflow(w, addr)
            urls = []
            for p in paths:
                if services_use_s3():
                    urls.append(upload_to_s3(p, str(uuid.uuid4())))
                else:
                    urls.append(_url_for_local_output(addr, p, LOCAL_OUTPUT_DIR))
            response["mask_urls"] = urls
            response["result"] = {"urls": urls, "frame_count": len(urls)}
            return response

        response["error"] = f"Unknown job: {job!r}"
        return response

    except TimeoutError:
        response["error"] = "Task timed out"
        return response
    except Exception as e:
        logger.error("SAM3 segment error: %s", e)
        response["error"] = str(e)
        return response
    finally:
        for bucket, key in staging_s3_keys:
            delete_s3_object(bucket, key)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="SAM3 segment AI service")
    p.add_argument("--test-mode", action="store_true")
    p.add_argument("--enable-default", action="store_true")
    p.add_argument("--default-port", type=int, default=8188)
    p.add_argument("--job", type=str, default="image_mask")
    p.add_argument("--image-url", type=str, default=None)
    p.add_argument("--video-url", type=str, default=None)
    p.add_argument("--positive-coords", type=str, default="[]")
    p.add_argument("--negative-coords", type=str, default="[]")
    p.add_argument("--text-prompt", type=str, default="")
    p.add_argument("--ref-frame-index", type=int, default=0)
    p.add_argument("--convert-local-to-url", action="store_true")
    p.add_argument("--sam3-options-json", type=str, default=None)
    return p.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    job = (args.job or "image_mask").strip().lower()
    try:
        pos = json.loads(args.positive_coords or "[]")
        neg = json.loads(args.negative_coords or "[]")
    except json.JSONDecodeError as e:
        print("ERROR: invalid coords JSON:", e, file=sys.stderr)
        sys.exit(1)
    if not local_servers.get("default"):
        local_servers["default"] = f"127.0.0.1:{args.default_port}"
    gpu_err, _ = gpu_preflight()
    if gpu_err:
        print("ERROR: " + gpu_err, file=sys.stderr)
        sys.exit(1)
    if not wait_for_service_ready(local_servers["default"]):
        print("ERROR: ComfyUI not reachable", file=sys.stderr)
        sys.exit(1)
    inp: dict[str, Any] = {
        "job": job,
        "positive_coords": pos,
        "negative_coords": neg,
        "text_prompt": _normalize_text_prompt(args.text_prompt),
        "ref_frame_index": args.ref_frame_index,
    }
    if args.sam3_options_json:
        try:
            raw = json.loads(args.sam3_options_json)
        except json.JSONDecodeError as e:
            print("ERROR: invalid --sam3-options-json:", e, file=sys.stderr)
            sys.exit(1)
        if isinstance(raw, dict):
            inp["sam3_options"] = raw
    if job == "video_masks":
        if not args.video_url:
            print("ERROR: --video-url required for video_masks", file=sys.stderr)
            sys.exit(1)
        inp["video_url"] = args.video_url
        apply_upload_local_paths_to_comfy_in_task(
            inp, local_servers["default"], subfolder="anime2026_sam3_test"
        )
    else:
        if not args.image_url:
            print("ERROR: --image-url required", file=sys.stderr)
            sys.exit(1)
        inp["image_url"] = args.image_url
        apply_upload_local_paths_to_comfy_in_task(
            inp, local_servers["default"], subfolder="anime2026_sam3_test"
        )
    print(json.dumps(handler({"input": inp}), indent=2))


def main() -> None:
    global convert_local_to_url
    args = _parse_args()
    env_flag = os.environ.get("CONVERT_LOCAL_IMAGE_TO_URL", "").lower() in (
        "1",
        "true",
        "yes",
    )
    convert_local_to_url = bool(args.convert_local_to_url or env_flag)
    if args.enable_default:
        local_servers["default"] = f"127.0.0.1:{args.default_port}"
        supported_tasks.append("sam3_segment")

    load_download_cache()

    if args.test_mode:
        _run_test_mode(args)
    else:
        if runpod is None:
            raise RuntimeError(
                "runpod is not installed; install it or run with --test-mode"
            )
        logger.info("Starting RunPod serverless service...")
        runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
