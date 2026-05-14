"""
Qwen Image Edit 2509 — RunPod serverless handler.
Supports inline prompts or pose/expression/file JSON catalogs.
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
except ModuleNotFoundError:  # local --test-mode should still work
    runpod = None  # type: ignore

from services.image_edit_ai_service import core
from services.utils import (
    apply_upload_local_paths_to_comfy_in_task,
    apply_convert_local_paths_to_urls_in_task,
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
        body = core.run_image_edit_job(
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
    parser = argparse.ArgumentParser(description="Image edit AI service")
    parser.add_argument("--test-mode", action="store_true")
    parser.add_argument("--enable-default", action="store_true")
    parser.add_argument("--default-port", type=int, default=8188)
    parser.add_argument("--image-url", type=str)
    parser.add_argument(
        "--prompts-json",
        type=str,
        help='Inline JSON array of prompts, e.g. \'["edit a","edit b"]\'',
    )
    parser.add_argument(
        "--prompt-source",
        choices=["inline", "pose", "expression"],
        default="inline",
    )
    parser.add_argument(
        "--indices-json",
        type=str,
        help='Catalog indices JSON array, e.g. \'[0,1,2]\' for test mode',
    )
    parser.add_argument(
        "--convert-local-to-url",
        action="store_true",
        help=(
            "Upload local image path(s) to S3 for download_input; delete staging "
            "objects after the job."
        ),
    )
    parser.add_argument(
        "--auxiliary-image-urls-json",
        type=str,
        default=None,
        help=(
            "Optional JSON array of up to 2 extra paths/URLs for Qwen 2509 LoadImage aux2/aux3: "
            "when using pose keypoint from logic, entry 0 is the character's base_closeup "
            "composite (four-angle grid) and entry 1 is the keypoint image; a single entry is "
            "keypoint-only. Example: '[\"/path/to/closeup.png\", \"/path/to/kp.png\"]'."
        ),
    )
    return parser.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    if not args.image_url:
        print("ERROR: --image-url required", file=sys.stderr)
        sys.exit(1)
    if not local_servers.get("default"):
        local_servers["default"] = f"127.0.0.1:{args.default_port}"
    # Fail fast: do not wait for ComfyUI if CUDA/GPU isn't usable.
    gpu_err, _gpu_detail = gpu_preflight()
    if gpu_err:
        print("ERROR: " + gpu_err, file=sys.stderr)
        sys.exit(1)
    if not wait_for_service_ready(local_servers["default"]):
        print(
            "ERROR: ComfyUI not at",
            local_servers["default"],
            file=sys.stderr,
        )
        sys.exit(1)

    inp: dict = {"image_url": args.image_url}
    if args.prompt_source == "inline":
        if args.prompts_json:
            plist = json.loads(args.prompts_json)
            inp["prompts"] = plist
        else:
            inp["prompts"] = ["Make the subject wave at the camera."]
        inp["prompt_source"] = "inline"
    else:
        inp["prompt_source"] = args.prompt_source
        if args.indices_json:
            inp["indices"] = json.loads(args.indices_json)
        else:
            inp["indices"] = [0, 1]

    if args.auxiliary_image_urls_json:
        aux = json.loads(args.auxiliary_image_urls_json)
        if not isinstance(aux, list):
            print(
                "ERROR: --auxiliary-image-urls-json must be a JSON array",
                file=sys.stderr,
            )
            sys.exit(1)
        inp["auxiliary_image_urls"] = aux

    apply_upload_local_paths_to_comfy_in_task(
        inp, local_servers["default"], subfolder="anime2026_image_edit_test"
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
