"""
Wan first-last-frame-to-video (lightning) — RunPod serverless + local --test-mode.
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

from services.flf2video_ai_service import core
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
individual_frames_default = False


def _parse_individual_frames_from_task(task: dict[str, Any]) -> bool | None:
    if "individual_frames" not in task:
        return None
    v = task["individual_frames"]
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return bool(int(v))
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "y", "on"):
        return True
    if s in ("0", "false", "no", "n", "off", ""):
        return False
    raise ValueError(f"invalid individual_frames value: {v!r}")


def effective_individual_frames(task: dict[str, Any]) -> bool:
    parsed = _parse_individual_frames_from_task(task)
    if parsed is not None:
        return parsed
    return individual_frames_default


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

        try:
            want_frames = effective_individual_frames(task)
        except ValueError as e:
            response["error"] = str(e)
            return response

        addr = local_servers.get("default", "127.0.0.1:8188")
        body = core.run_flf2video_job(
            task,
            workflows=workflows,
            server_address=addr,
            individual_frames=want_frames,
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


def _cli_image_url_to_task_fragment(s: str) -> dict:
    raw = (s or "").strip()
    if not raw:
        raise ValueError("--image-url is empty")
    if raw.startswith("["):
        data = json.loads(raw)
        if isinstance(data, list):
            refs = [str(x).strip() for x in data if str(x).strip()]
            if not refs:
                raise ValueError(
                    "JSON array for --image-url must contain at least one non-empty string"
                )
            return {"image_urls": refs}
        if isinstance(data, str) and data.strip():
            return {"image_url": data.strip()}
        raise ValueError(
            "JSON for --image-url must be an array of strings or a single string"
        )
    return {"image_url": raw}


def _parse_comma_ints(s: str | None, *, name: str) -> list[int]:
    if not s or not str(s).strip():
        raise ValueError(f"{name} is empty")
    parts = [p.strip() for p in str(s).replace(",", " ").split() if p.strip()]
    return [int(p) for p in parts]


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="FLF2Video (Wan lightning) AI service")
    p.add_argument("--test-mode", action="store_true")
    p.add_argument("--enable-default", action="store_true")
    p.add_argument("--default-port", type=int, default=8188)
    p.add_argument(
        "--image-url",
        type=str,
        default=None,
        help=(
            "One image URL/path or JSON array of strings for multiple frames, e.g. "
            '\'["a.png","b.png","c.png"]\''
        ),
    )
    p.add_argument(
        "--frames",
        type=str,
        default=None,
        help="1-based indices into images, comma-separated, e.g. 1,2,3 (min 2 values)",
    )
    p.add_argument(
        "--length",
        type=str,
        default=None,
        help=(
            "Per-pair frame length(s), comma-separated (default 33). "
            "e.g. 33 or 33,37,41 for multiple pairs"
        ),
    )
    p.add_argument(
        "--positive-prompt",
        type=str,
        default=None,
        help="Optional positive prompt (CLIP encode)",
    )
    p.add_argument(
        "--convert-local-to-url",
        action="store_true",
        help="Upload local paths in image_url(s) to S3 for remote download_input.",
    )
    p.add_argument(
        "--individual-frames",
        action="store_true",
        help=(
            "Decode each output video to PNGs under output/flf2video_frames/ and "
            "return frame_urls per pair (overridable per job via input.individual_frames). "
            "Default can also be set with FLF2VIDEO_INDIVIDUAL_FRAMES=1."
        ),
    )
    return p.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    if not args.image_url:
        print("ERROR: --image-url required in test mode", file=sys.stderr)
        sys.exit(1)
    if not args.frames:
        print("ERROR: --frames required in test mode (e.g. --frames 1,2,3)", file=sys.stderr)
        sys.exit(1)
    try:
        img_frag = _cli_image_url_to_task_fragment(args.image_url)
    except (ValueError, json.JSONDecodeError) as e:
        print("ERROR: invalid --image-url:", e, file=sys.stderr)
        sys.exit(1)
    try:
        frames = _parse_comma_ints(args.frames, name="--frames")
    except ValueError as e:
        print("ERROR:", e, file=sys.stderr)
        sys.exit(1)

    inp: dict[str, Any] = {**img_frag, "frames": frames}
    if args.length is not None and str(args.length).strip():
        try:
            lengths = _parse_comma_ints(args.length, name="--length")
            if len(lengths) == 1:
                inp["length"] = lengths[0]
            else:
                inp["lengths"] = lengths
        except ValueError as e:
            print("ERROR:", e, file=sys.stderr)
            sys.exit(1)
    if args.positive_prompt:
        inp["positive_prompt"] = args.positive_prompt

    if not local_servers.get("default"):
        local_servers["default"] = f"127.0.0.1:{args.default_port}"
    gpu_err, _gpu_detail = gpu_preflight()
    if gpu_err:
        print("ERROR: " + gpu_err, file=sys.stderr)
        sys.exit(1)
    if not wait_for_service_ready(local_servers["default"]):
        print(
            "ERROR: ComfyUI not reachable at",
            local_servers["default"],
            file=sys.stderr,
        )
        sys.exit(1)

    apply_upload_local_paths_to_comfy_in_task(
        inp, local_servers["default"], subfolder="anime2026_flf2video_test"
    )
    print(json.dumps(handler({"input": inp}), indent=2))


def main() -> None:
    global convert_local_to_url, individual_frames_default
    args = _parse_args()
    env_flag = os.environ.get("CONVERT_LOCAL_IMAGE_TO_URL", "").lower() in (
        "1",
        "true",
        "yes",
    )
    convert_local_to_url = bool(args.convert_local_to_url or env_flag)
    env_if = os.environ.get("FLF2VIDEO_INDIVIDUAL_FRAMES", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "y",
        "on",
    )
    individual_frames_default = bool(args.individual_frames or env_if)
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
        logger.info("Starting RunPod serverless (flf2video)...")
        runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
