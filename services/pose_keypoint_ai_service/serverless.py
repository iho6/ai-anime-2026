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
from typing import Any

try:
    import runpod  # type: ignore
except ModuleNotFoundError:
    runpod = None  # type: ignore

from services.pose_keypoint_ai_service import core
from services.utils import (
    apply_convert_local_paths_to_urls_in_task,
    apply_upload_local_paths_to_comfy_in_task,
    delete_s3_object,
    gpu_preflight,
    load_download_cache,
    load_workflows,
    timing_decorator,
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
convert_local_to_url = False


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
        body = core.run_pose_keypoint_job(
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
