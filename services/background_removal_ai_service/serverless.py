"""
Background removal (RMBG-2.0 / ComfyUI-RMBG) — RunPod serverless + local --test-mode.
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

try:
    import runpod  # type: ignore
except ModuleNotFoundError:  # local --test-mode should still work
    runpod = None  # type: ignore

from services.background_removal_ai_service import core
from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.utils import (
    apply_upload_local_paths_to_comfy_in_task,
    apply_convert_local_paths_to_urls_in_task,
    delete_s3_object,
    fetch_comfy_history,
    gpu_preflight,
    load_download_cache,
    load_workflows,
    normalize_image_urls,
    resolve_to_comfy_input_ref,
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

_LEGACY_REMBG_KEYS = frozenset({"torchscript_jit", "use_advanced", "threshold"})
_legacy_keys_warned = False


def _rmbg_overrides_from_task(task: dict) -> dict[str, object] | None:
    global _legacy_keys_warned
    if any(k in task for k in _LEGACY_REMBG_KEYS) and not _legacy_keys_warned:
        logger.debug(
            "Ignoring legacy InspyreNet task keys: %s",
            sorted(k for k in _LEGACY_REMBG_KEYS if k in task),
        )
        _legacy_keys_warned = True
    raw = task.get("rmbg")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("rmbg must be an object with RMBG node input overrides")
    return dict(raw)


@timing_decorator
def handler(job_input: dict) -> dict:
    """Job input: image_url or image_urls; optional rmbg (RMBG node inputs, except image)."""
    now = int(time.time())
    response: dict = {
        "created_at": now,
        "queued_at": now,
        "variations": {"total_count": 0, "items": []},
        "error": None,
    }
    staging_s3_keys: list[tuple[str, str]] = []

    try:
        task = job_input.get("input")
        if not isinstance(task, dict):
            response["error"] = "Missing or invalid job input"
            return response

        logger.info("Received task: %s", task)

        gpu_err, gpu_detail = gpu_preflight()
        if gpu_err:
            logger.error("[gpu-preflight] %s", gpu_err)
            response["error"] = gpu_err
            return response
        logger.info("[gpu-preflight] OK (%s)", gpu_detail)

        if convert_local_to_url:
            staging_s3_keys = apply_convert_local_paths_to_urls_in_task(task)

        try:
            urls = normalize_image_urls(task)
        except ValueError as e:
            response["error"] = str(e)
            return response

        try:
            rmbg_overrides = _rmbg_overrides_from_task(task)
        except ValueError as e:
            response["error"] = str(e)
            return response

        addr = local_servers.get("default", "127.0.0.1:8188")
        output_dir = LOCAL_OUTPUT_DIR
        items: list[dict] = []

        for image_index, image_url in enumerate(urls):
            try:
                comfy_input_ref = resolve_to_comfy_input_ref(
                    image_url, addr, subfolder="anime2026_background_removal_inputs"
                )
            except Exception as e:
                logger.error(e)
                response["error"] = f"Failed to resolve image: {image_url}"
                return response

            try:
                prompt_id = core.run_rembg_workflow(
                    comfy_input_ref,
                    workflows,
                    addr,
                    rmbg_overrides=rmbg_overrides,
                )
                waiting_for_results(prompt_id, addr, timeout_seconds=TIMEOUT)
                history = fetch_comfy_history(addr, prompt_id)
                outputs = (history.get(prompt_id) or {}).get("outputs") or {}
                out_filename = None
                for _nid, out in outputs.items():
                    imgs = out.get("images")
                    if imgs:
                        out_filename = imgs[0].get("filename")
                        break
                if out_filename and osp.isfile(osp.join(output_dir, out_filename)):
                    local_out = osp.join(output_dir, out_filename)
                    use_s3 = (os.environ.get("SERVICES_USE_S3") or "").strip().lower() in {
                        "1",
                        "true",
                        "yes",
                        "y",
                        "on",
                    }
                    if use_s3:
                        upload_name = str(uuid.uuid4())
                        output_url = upload_to_s3(local_out, upload_name)
                    else:
                        qfn = urllib.parse.quote(out_filename)
                        output_url = f"http://{addr}/view?filename={qfn}&type=output"
                    items.append(
                        {
                            "id": str(uuid.uuid4()),
                            "type": "background_removal",
                            "created_at": int(time.time()),
                            "image_index": image_index,
                            "source_url": image_url,
                            "result": {"url": output_url},
                        }
                    )
                else:
                    response["error"] = (
                        "Workflow completed but output image not found "
                        f"(input index {image_index})"
                    )
                    return response
            except Exception as e:
                logger.error(e)
                response["error"] = (
                    f"Workflow execution failed (input index {image_index}): {e}"
                )
                return response

        response["variations"]["total_count"] = len(items)
        response["variations"]["items"] = items
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
    """
    Parse --image-url for test mode: one URL/path, or a JSON array of strings.
    """
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


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Background removal AI service")
    p.add_argument("--test-mode", action="store_true")
    p.add_argument("--enable-default", action="store_true")
    p.add_argument("--default-port", type=int, default=8188)
    p.add_argument(
        "--image-url",
        type=str,
        default=None,
        help=(
            "One image URL, local path, or a JSON array of strings, e.g. "
            '\'["https://a/x.png","https://b/y.png"]\''
        ),
    )
    p.add_argument(
        "--convert-local-to-url",
        action="store_true",
        help="Upload local image_url paths to S3 for download_input.",
    )
    return p.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    if not args.image_url:
        print("ERROR: --image-url required in test mode", file=sys.stderr)
        sys.exit(1)
    try:
        img_frag = _cli_image_url_to_task_fragment(args.image_url)
    except (ValueError, json.JSONDecodeError) as e:
        print("ERROR: invalid --image-url:", e, file=sys.stderr)
        sys.exit(1)
    if not local_servers.get("default"):
        local_servers["default"] = f"127.0.0.1:{args.default_port}"
    # Fail fast: do not wait for ComfyUI if CUDA/GPU isn't usable.
    gpu_err, _gpu_detail = gpu_preflight()
    if gpu_err:
        print("ERROR: " + gpu_err, file=sys.stderr)
        sys.exit(1)
    if not wait_for_service_ready(local_servers["default"]):
        print("ERROR: ComfyUI not reachable at", local_servers["default"], file=sys.stderr)
        sys.exit(1)
    inp: dict = {**img_frag}
    apply_upload_local_paths_to_comfy_in_task(
        inp, local_servers["default"], subfolder="anime2026_rembg_test"
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
        supported_tasks.append("background_removal")

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
