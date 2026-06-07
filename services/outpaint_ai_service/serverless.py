"""
Flux-fill outpaint — RunPod serverless handler.
Extends a source image in any direction using the Flux-fill model.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import os.path as osp
import random
import sys
import time
import urllib.parse
import urllib.request
import uuid
from copy import deepcopy
from typing import Any

try:
    import runpod  # type: ignore
except ModuleNotFoundError:
    runpod = None  # type: ignore

from services import prompts
from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.utils import (
    apply_convert_local_paths_to_urls_in_task,
    apply_upload_local_paths_to_comfy_in_task,
    delete_s3_object,
    gpu_preflight,
    load_download_cache,
    load_workflows,
    resolve_to_comfy_input_ref,
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

WORKFLOW_STEM = "flux_fill_outpaint"

# Workflow node IDs
_NODE_LOAD_IMAGE = "17"
_NODE_PAD = "44"
_NODE_CLIP_TEXT = "23"
_NODE_KSAMPLER = "3"
_NODE_FLUX_GUIDANCE = "26"


def normalize_outpaint_inputs(task: dict) -> dict[str, Any]:
    image_url = task.get("image_url")
    if not image_url or not str(image_url).strip():
        raise ValueError("image_url is required")

    def _int(key: str, default: int, min_val: int = 0) -> int:
        v = task.get(key, default)
        try:
            v = int(v)
        except (TypeError, ValueError):
            raise ValueError(f"{key} must be an integer, got {v!r}")
        if v < min_val:
            raise ValueError(f"{key} must be >= {min_val}, got {v}")
        return v

    def _float(key: str, default: float, min_val: float = 0.0, max_val: float = 1e9) -> float:
        v = task.get(key, default)
        try:
            v = float(v)
        except (TypeError, ValueError):
            raise ValueError(f"{key} must be a number, got {v!r}")
        if not (min_val <= v <= max_val):
            raise ValueError(f"{key} must be between {min_val} and {max_val}, got {v}")
        return v

    seed = task.get("seed")
    if seed is None:
        seed = random.randint(0, 2**32 - 1)
    else:
        try:
            seed = int(seed)
        except (TypeError, ValueError):
            raise ValueError(f"seed must be an integer, got {seed!r}")

    return {
        "image_url": str(image_url).strip(),
        "prompt": str(task.get("prompt", prompts.DEFAULT_OUTPAINT_PROMPT)).strip(),
        "left": _int("left", 400),
        "top": _int("top", 0),
        "right": _int("right", 400),
        "bottom": _int("bottom", 400),
        "feathering": _int("feathering", 24),
        "seed": seed,
        "steps": _int("steps", 20, min_val=1),
        "guidance": _float("guidance", 30.0, min_val=0.0),
        "denoise": _float("denoise", 1.0, min_val=0.0, max_val=1.0),
    }


def run_outpaint(
    api_workflow: dict,
    comfy_image_ref: str,
    inputs: dict[str, Any],
    server_address: str,
) -> str:
    w = deepcopy(api_workflow)

    w[_NODE_LOAD_IMAGE]["inputs"]["image"] = comfy_image_ref

    pad = w[_NODE_PAD]["inputs"]
    pad["left"] = inputs["left"]
    pad["top"] = inputs["top"]
    pad["right"] = inputs["right"]
    pad["bottom"] = inputs["bottom"]
    pad["feathering"] = inputs["feathering"]

    w[_NODE_CLIP_TEXT]["inputs"]["text"] = inputs["prompt"]

    ks = w[_NODE_KSAMPLER]["inputs"]
    ks["seed"] = inputs["seed"]
    ks["steps"] = inputs["steps"]
    ks["denoise"] = inputs["denoise"]

    w[_NODE_FLUX_GUIDANCE]["inputs"]["guidance"] = inputs["guidance"]

    return task_queue(w, server_address)


def get_first_output_filename(history: dict, prompt_id: str, output_dir: str) -> str | None:
    outputs = (history.get(prompt_id) or {}).get("outputs") or {}
    for _nid, out in outputs.items():
        imgs = out.get("images")
        if imgs:
            fn = imgs[0].get("filename")
            if fn and osp.isfile(osp.join(output_dir, fn)):
                return fn
    return None


def run_outpaint_job(
    task: dict,
    *,
    workflows: dict,
    server_address: str,
) -> dict[str, Any]:
    out: dict[str, Any] = {"results": []}
    try:
        inputs = normalize_outpaint_inputs(task)

        api = workflows.get(WORKFLOW_STEM)
        if not api:
            raise RuntimeError(
                f"Workflow {WORKFLOW_STEM} not loaded; add workflows/{WORKFLOW_STEM}.json"
            )

        try:
            comfy_image_ref = resolve_to_comfy_input_ref(
                inputs["image_url"],
                server_address,
                subfolder="anime2026_outpaint_inputs",
            )
        except Exception as e:
            logger.error("Input resolve failed: %s", e)
            out["error"] = f"Failed to resolve image: {inputs['image_url']}"
            return out

        use_s3 = services_use_s3()

        try:
            pid = run_outpaint(api, comfy_image_ref, inputs, server_address)
            waiting_for_results(pid, server_address, timeout_seconds=TIMEOUT)
            with urllib.request.urlopen(
                f"http://{server_address}/history/{pid}"
            ) as resp:
                history = json.loads(resp.read().decode("utf-8"))
            fn = get_first_output_filename(history, pid, LOCAL_OUTPUT_DIR)
            if not fn:
                out["error"] = "No output image produced by workflow"
                return out
            local_file = osp.join(LOCAL_OUTPUT_DIR, fn)
            if use_s3:
                url = upload_to_s3(local_file, str(uuid.uuid4()))
            else:
                qfn = urllib.parse.quote(fn)
                url = f"http://{server_address}/view?filename={qfn}&type=output"
            out["results"].append({"url": url})
        except Exception as e:
            logger.error("Workflow run failed: %s", e)
            out["error"] = f"Workflow failed: {e}"
            return out

        return out
    except ValueError as e:
        out["error"] = str(e)
        return out
    except Exception as e:
        logger.error("Job error: %s", e)
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
        body = run_outpaint_job(task, workflows=workflows, server_address=addr)
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
    parser = argparse.ArgumentParser(description="Flux-fill outpaint AI service")
    parser.add_argument("--test-mode", action="store_true")
    parser.add_argument("--enable-default", action="store_true")
    parser.add_argument("--default-port", type=int, default=8188)
    parser.add_argument("--image-url", type=str)
    parser.add_argument("--prompt", type=str, default=prompts.DEFAULT_OUTPAINT_PROMPT)
    parser.add_argument("--left", type=int, default=400)
    parser.add_argument("--top", type=int, default=0)
    parser.add_argument("--right", type=int, default=400)
    parser.add_argument("--bottom", type=int, default=400)
    parser.add_argument("--feathering", type=int, default=24)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--steps", type=int, default=20)
    parser.add_argument("--guidance", type=float, default=30.0)
    parser.add_argument("--denoise", type=float, default=1.0)
    parser.add_argument(
        "--convert-local-to-url",
        action="store_true",
        help="Upload local image path to S3 for download_input; delete after job.",
    )
    return parser.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    if not args.image_url:
        print("ERROR: --image-url required", file=sys.stderr)
        sys.exit(1)
    if not local_servers.get("default"):
        local_servers["default"] = f"127.0.0.1:{args.default_port}"
    gpu_err, _gpu_detail = gpu_preflight()
    if gpu_err:
        print("ERROR: " + gpu_err, file=sys.stderr)
        sys.exit(1)
    if not wait_for_service_ready(local_servers["default"]):
        print("ERROR: ComfyUI not at", local_servers["default"], file=sys.stderr)
        sys.exit(1)

    inp: dict = {
        "image_url": args.image_url,
        "prompt": args.prompt,
        "left": args.left,
        "top": args.top,
        "right": args.right,
        "bottom": args.bottom,
        "feathering": args.feathering,
        "steps": args.steps,
        "guidance": args.guidance,
        "denoise": args.denoise,
    }
    if args.seed is not None:
        inp["seed"] = args.seed

    apply_upload_local_paths_to_comfy_in_task(
        inp, local_servers["default"], subfolder="anime2026_outpaint_test"
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
