"""
Qwen-Image 2512 text-to-image (reference gen) — RunPod serverless.

Base input is a text prompt plus image width/height; every other input
(seed, steps, cfg, sampler, models) is defaulted by the workflow. Reuses the
Qwen text encoder + VAE already downloaded for the image-edit services.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import os.path as osp
import secrets
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
    gpu_preflight,
    load_download_cache,
    load_workflows,
    services_use_s3,
    summarize_comfy_history_entry,
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

WORKFLOW_STEM = "image_qwen_t2i_api"
POSITIVE_NODE_ID = "5"           # CLIPTextEncode (positive prompt)
LATENT_NODE_ID = "7"             # EmptySD3LatentImage (width/height/batch_size)
SAMPLER_NODE_ID = "8"            # KSampler (seed)

DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 1024


def _coerce_dim(value: Any, default: int) -> int:
    try:
        d = int(value)
    except (TypeError, ValueError):
        return default
    if d <= 0:
        return default
    return d


def get_first_output_image_ref(
    history: dict, prompt_id: str, output_dir: str
) -> dict[str, str] | None:
    outputs = (history.get(prompt_id) or {}).get("outputs") or {}
    for _nid, out in outputs.items():
        imgs = out.get("images")
        if imgs:
            img0 = imgs[0] or {}
            fn = img0.get("filename")
            subfolder = img0.get("subfolder")
            img_type = img0.get("type") or "output"
            if not isinstance(fn, str) or not fn.strip():
                continue
            ref: dict[str, str] = {"filename": fn.strip(), "type": str(img_type)}
            if isinstance(subfolder, str) and subfolder.strip():
                ref["subfolder"] = subfolder.strip()
            rel = (
                osp.join(ref.get("subfolder", ""), ref["filename"])
                if ref.get("subfolder")
                else ref["filename"]
            )
            if osp.isfile(osp.join(output_dir, rel)):
                ref["local_relpath"] = rel
            return ref
    return None


def _download_comfy_output_to_local(
    *,
    server_address: str,
    filename: str,
    subfolder: str | None,
    img_type: str,
) -> str:
    os.makedirs(LOCAL_OUTPUT_DIR, exist_ok=True)
    suffix = osp.splitext(filename)[1] or ".png"
    dest = osp.join(LOCAL_OUTPUT_DIR, f"comfy_{uuid.uuid4().hex[:12]}{suffix}")
    q = {"filename": filename, "type": img_type}
    if subfolder:
        q["subfolder"] = subfolder
    url = f"http://{server_address}/view?{urllib.parse.urlencode(q)}"
    with urllib.request.urlopen(url) as resp:
        data = resp.read()
    with open(dest, "wb") as f:
        f.write(data)
    return dest


def run_one_generation(
    api_workflow: dict,
    prompt: str,
    width: int,
    height: int,
    server_address: str,
) -> str:
    w = deepcopy(api_workflow)

    pos = w.get(POSITIVE_NODE_ID)
    if not isinstance(pos, dict) or pos.get("class_type") != "CLIPTextEncode":
        raise RuntimeError(
            f"Workflow missing CLIPTextEncode positive node {POSITIVE_NODE_ID}"
        )
    pos.setdefault("inputs", {})["text"] = prompt

    # KSampler infers latent dims from the latent node, so width/height is set once.
    latent = w.get(LATENT_NODE_ID)
    if not isinstance(latent, dict) or latent.get("class_type") != "EmptySD3LatentImage":
        raise RuntimeError(
            f"Workflow missing EmptySD3LatentImage node {LATENT_NODE_ID}"
        )
    latent.setdefault("inputs", {})["width"] = int(width)
    latent["inputs"]["height"] = int(height)

    seed = secrets.randbelow(2**63)
    sampler = w.get(SAMPLER_NODE_ID)
    if isinstance(sampler, dict) and sampler.get("class_type") == "KSampler":
        sampler.setdefault("inputs", {})["seed"] = seed
    else:
        for _nid, node in w.items():
            if isinstance(node, dict) and node.get("class_type") == "KSampler":
                node.setdefault("inputs", {})["seed"] = seed

    return task_queue(w, server_address)


def run_qwen_t2i_job(
    task: dict,
    *,
    workflows: dict,
    server_address: str,
) -> dict[str, Any]:
    out: dict[str, Any] = {"results": []}
    try:
        prompt = str(task.get("prompt") or "").strip()
        if not prompt:
            raise ValueError("prompt must be non-empty")
        width = _coerce_dim(task.get("width", DEFAULT_WIDTH), DEFAULT_WIDTH)
        height = _coerce_dim(task.get("height", DEFAULT_HEIGHT), DEFAULT_HEIGHT)

        api = workflows.get(WORKFLOW_STEM)
        if not api:
            raise RuntimeError(
                f"Workflow {WORKFLOW_STEM} not loaded; add workflows/{WORKFLOW_STEM}.json"
            )

        p_idx = 0
        pid: str | None = None
        try:
            pid = run_one_generation(api, prompt, width, height, server_address)
            waiting_for_results(pid, server_address, timeout_seconds=TIMEOUT)
            with urllib.request.urlopen(
                f"http://{server_address}/history/{pid}"
            ) as resp:
                history = json.loads(resp.read().decode("utf-8"))
            ref = get_first_output_image_ref(history, pid, LOCAL_OUTPUT_DIR)
            if not ref:
                entry = (
                    history.get(pid)
                    if isinstance(history, dict) and pid in history
                    else history
                )
                if isinstance(entry, dict):
                    summ = summarize_comfy_history_entry(entry)
                    logger.error(
                        "No output image prompt_index=%s prompt_id=%s comfy=%s",
                        p_idx,
                        pid,
                        json.dumps(summ, default=str),
                    )
                out["error"] = f"No output image for prompt_index {p_idx}"
                out["prompt_index"] = p_idx
                if pid:
                    out["prompt_id"] = pid
                return out
            if ref.get("local_relpath"):
                local_file = osp.join(LOCAL_OUTPUT_DIR, ref["local_relpath"])
            else:
                local_file = _download_comfy_output_to_local(
                    server_address=server_address,
                    filename=ref["filename"],
                    subfolder=ref.get("subfolder"),
                    img_type=ref.get("type") or "output",
                )
            if services_use_s3():
                upload_name = str(uuid.uuid4())
                url = upload_to_s3(local_file, upload_name)
                out["results"].append(
                    {
                        "prompt_index": p_idx,
                        "user_prompt": prompt,
                        "full_prompt": prompt,
                        "url": url,
                    }
                )
            else:
                out["results"].append(
                    {
                        "prompt_index": p_idx,
                        "user_prompt": prompt,
                        "full_prompt": prompt,
                        "local_path": osp.abspath(local_file),
                    }
                )
        except Exception as e:
            logger.error("Run failed prompt_index=%s: %s", p_idx, e)
            out["error"] = f"Workflow failed for prompt {p_idx}: {e}"
            out["prompt_index"] = p_idx
            if pid:
                out["prompt_id"] = pid
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
        body = run_qwen_t2i_job(
            task,
            workflows=workflows,
            server_address=addr,
        )
        if body.get("error"):
            response["error"] = body["error"]
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
    parser = argparse.ArgumentParser(description="Qwen-Image 2512 text-to-image (reference gen)")
    parser.add_argument("--test-mode", action="store_true")
    parser.add_argument("--enable-default", action="store_true")
    parser.add_argument("--default-port", type=int, default=8188)
    parser.add_argument("--prompt", type=str, help="Text prompt for generation")
    parser.add_argument(
        "--width", type=int, default=DEFAULT_WIDTH, help="Output image width"
    )
    parser.add_argument(
        "--height", type=int, default=DEFAULT_HEIGHT, help="Output image height"
    )
    parser.add_argument(
        "--convert-local-to-url",
        action="store_true",
        help="No-op for this service (no image input); kept for CLI consistency.",
    )
    return parser.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    if not local_servers.get("default"):
        local_servers["default"] = f"127.0.0.1:{args.default_port}"
    gpu_err, _gpu_detail = gpu_preflight()
    if gpu_err:
        print("ERROR: " + gpu_err, file=sys.stderr)
        sys.exit(1)
    if not wait_for_service_ready(local_servers["default"]):
        print("ERROR: ComfyUI not at", local_servers["default"], file=sys.stderr)
        sys.exit(1)

    prompt = args.prompt or "a serene mountain lake at golden hour, photorealistic"
    inp = {"prompt": prompt, "width": args.width, "height": args.height}
    print(json.dumps(handler({"input": inp}), indent=2))


def main() -> None:
    args = _parse_args()
    if args.convert_local_to_url:
        logger.info("--convert-local-to-url ignored (t2i has no image_url input)")
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
