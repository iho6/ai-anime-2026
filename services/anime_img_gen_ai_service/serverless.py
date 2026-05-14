"""
Anima preview anime T2I — RunPod serverless.
Prepends quality/anime style prefix; user supplies scene/subject only.
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

import runpod

from services.anime_img_gen_ai_service import core
from services.utils import (
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


@timing_decorator
def handler(job_input: dict[str, Any]) -> dict[str, Any]:
    response: dict[str, Any] = {
        "created_at": int(time.time()),
        "queued_at": int(time.time()),
        "results": [],
        "error": None,
        "prompt_id": None,
        "prompt_index": None,
    }

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

        addr = local_servers.get("default", "127.0.0.1:8188")
        body = core.run_anime_gen_job(
            task,
            workflows=workflows,
            server_address=addr,
        )
        if body.get("error"):
            response["error"] = body["error"]
            # Preserve debug context for clients (e.g. UI) to inspect Comfy history.
            if isinstance(body.get("prompt_id"), str):
                response["prompt_id"] = body.get("prompt_id")
            if isinstance(body.get("prompt_index"), int):
                response["prompt_index"] = body.get("prompt_index")
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


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Anime image gen (Anima preview)")
    parser.add_argument("--test-mode", action="store_true")
    parser.add_argument("--enable-default", action="store_true")
    parser.add_argument("--default-port", type=int, default=8188)
    parser.add_argument(
        "--prompt", type=str, help="Single user prompt (subject/scene)"
    )
    parser.add_argument(
        "--prompts-json",
        type=str,
        help='JSON array of prompts, e.g. \'["girl under cherry tree","robot cat"]\'',
    )
    parser.add_argument(
        "--convert-local-to-url",
        action="store_true",
        help="No-op for this service (no image input); kept for CLI consistency.",
    )
    parser.add_argument(
        "--skip-default-style-prefix",
        action="store_true",
        help=(
            "Treat --prompt/--prompts-json as the full positive (no DEFAULT_STYLE_PREFIX). "
            "Used by new-character base draft."
        ),
    )
    return parser.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    if not local_servers.get("default"):
        local_servers["default"] = f"127.0.0.1:{args.default_port}"
    # Fail fast: do not wait for ComfyUI if CUDA/GPU isn't usable.
    gpu_err, _gpu_detail = gpu_preflight()
    if gpu_err:
        print("ERROR: " + gpu_err, file=sys.stderr)
        sys.exit(1)
    if not wait_for_service_ready(local_servers["default"]):
        print("ERROR: ComfyUI not at", local_servers["default"], file=sys.stderr)
        sys.exit(1)

    if args.prompts_json:
        plist = json.loads(args.prompts_json)
        inp = {"prompts": plist}
    elif args.prompt:
        inp = {"prompt": args.prompt}
    else:
        inp = {"prompt": "a girl reading a book by the window, soft morning light"}
    if args.skip_default_style_prefix:
        inp["skip_default_style_prefix"] = True
    print(json.dumps(handler({"input": inp}), indent=2))


def main() -> None:
    args = _parse_args()
    if args.convert_local_to_url:
        logger.info("--convert-local-to-url ignored (anime gen has no image_url input)")
    if args.enable_default:
        local_servers["default"] = f"127.0.0.1:{args.default_port}"

    load_download_cache()

    if args.test_mode:
        _run_test_mode(args)
    else:
        logger.info("Starting RunPod serverless...")
        runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
