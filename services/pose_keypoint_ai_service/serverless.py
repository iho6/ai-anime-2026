"""
SDPose keypoint overlay — RunPod serverless + local --test-mode.
Inputs: image_url / image_urls, or video_url; optional export_frame for per-frame PNGs.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import os.path as osp
import sys
import time
import uuid
import urllib.parse
import urllib.request
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
    find_first_node_id,
    gpu_preflight,
    load_download_cache,
    load_workflows,
    normalize_image_urls,
    resolve_to_comfy_input_ref,
    resolve_to_comfy_video_file_ref,
    services_use_s3,
    task_queue,
    timing_decorator,
    upload_to_s3,
    wait_for_service_ready,
    waiting_for_results,
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
convert_local_to_url = False

WF_IMAGE = "utility_sdpose_ood_image_to_pose"
WF_VIDEO = "utility_sdpose_ood_video_to_pose_map_api"
WF_VIDEO_FRAMES = "utility_sdpose_ood_video_to_pose_frames_api"

_VIDEO_SUFFIXES = (".mp4", ".webm", ".mov", ".mkv", ".avi")


def _normalize_comfy_file_ref(ref: str) -> str:
    r = str(ref).strip()
    if osp.isfile(r):
        return osp.basename(r)
    return r


def _collect_output_entries(
    history: dict, prompt_id: str
) -> list[tuple[str, str]]:
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
    nid = find_first_node_id(w, "LoadImage")
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
    nid = find_first_node_id(w, "LoadVideo")
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
    _ = service_dir
    wf_map = workflows
    out: dict[str, Any] = {"results": []}
    use_s3 = services_use_s3()

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


@timing_decorator
def handler(job_input: dict[str, Any]) -> dict[str, Any]:
    response: dict[str, Any] = {
        "created_at": int(time.time()),
        "queued_at": int(time.time()),
        "results": [],
        "error": None,
    }
    staging_s3_keys: list[tuple[str, str]] = []

    try:
        gpu_err, gpu_detail = gpu_preflight()
        if gpu_err:
            logger.error("[gpu-preflight] %s", gpu_err)
            response["error"] = gpu_err
            return response
        logger.info("[gpu-preflight] OK (%s)", gpu_detail)

        task = job_input.get("input")
        if not isinstance(task, dict):
            response["error"] = "Missing or invalid job input"
            return response

        if convert_local_to_url:
            staging_s3_keys = apply_convert_local_paths_to_urls_in_task(task)

        addr = local_servers.get("default", "127.0.0.1:8188")
        body = run_pose_keypoint_job(
            task,
            service_dir=_SERVICE_DIR,
            workflows=workflows,
            server_address=addr,
        )
        if body.get("error"):
            response["error"] = body["error"]
            return response
        response["results"] = body.get("results", [])
        return response

    except TimeoutError:
        response["error"] = "Task timed out"
        return response
    except Exception as e:
        logger.error("Critical error: %s", e)
        response["error"] = str(e)
        return response
    finally:
        for bucket, key in staging_s3_keys:
            delete_s3_object(bucket, key)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pose keypoint AI service (SDPose)")
    parser.add_argument("--test-mode", action="store_true")
    parser.add_argument("--enable-default", action="store_true")
    parser.add_argument("--default-port", type=int, default=8188)
    parser.add_argument("--image-url", type=str, help="Image URL, path, or JSON array of URLs")
    parser.add_argument("--video-url", type=str, help="Video URL or local path")
    parser.add_argument(
        "--export-frame",
        action="store_true",
        help="With --video-url: output per-frame keypoint PNGs instead of a video",
    )
    parser.add_argument(
        "--convert-local-to-url",
        action="store_true",
        help="Stage local paths via S3 for remote download_input compatibility.",
    )
    return parser.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    if not args.image_url and not args.video_url:
        print("ERROR: --image-url and/or --video-url required", file=sys.stderr)
        sys.exit(1)
    if args.image_url and args.video_url:
        print("ERROR: use only one of --image-url or --video-url in test mode", file=sys.stderr)
        sys.exit(1)

    if not local_servers.get("default"):
        local_servers["default"] = f"127.0.0.1:{args.default_port}"
    gpu_err, _ = gpu_preflight()
    if gpu_err:
        print("ERROR: " + gpu_err, file=sys.stderr)
        sys.exit(1)
    if not wait_for_service_ready(local_servers["default"]):
        print("ERROR: ComfyUI not at", local_servers["default"], file=sys.stderr)
        sys.exit(1)

    inp: dict[str, Any] = {}
    if args.video_url:
        inp["video_url"] = args.video_url
        if args.export_frame:
            inp["export_frame"] = True
    else:
        raw = (args.image_url or "").strip()
        if raw.startswith("["):
            data = json.loads(raw)
            if isinstance(data, list):
                inp["image_urls"] = [str(x).strip() for x in data if str(x).strip()]
            else:
                inp["image_url"] = str(data).strip()
        else:
            inp["image_url"] = raw

    apply_upload_local_paths_to_comfy_in_task(
        inp,
        local_servers["default"],
        subfolder="anime2026_pose_keypoint_test",
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

    load_download_cache()

    if args.test_mode:
        _run_test_mode(args)
    else:
        if runpod is None:
            raise RuntimeError(
                "runpod is not installed; install it or run with --test-mode"
            )
        logger.info("Starting RunPod serverless...")
        runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
