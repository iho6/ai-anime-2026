"""Native Wan 2.2 14B T2V Lightning — RunPod serverless + local test mode."""

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
from copy import deepcopy
from typing import Any

try:
    import runpod  # type: ignore
except ModuleNotFoundError:
    runpod = None  # type: ignore

from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.utils import (
    extract_video_frames_to_pngs,
    fetch_comfy_history,
    first_video_output_path,
    gpu_preflight,
    load_download_cache,
    load_workflows,
    task_queue,
    timing_decorator,
    view_or_s3_url_for_output_file,
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
local_servers: dict[str, str] = {}
individual_frames_default = False

API_KEY = "video_wan2_2_14B_t2v_lightning_api"
DEFAULT_WIDTH = 640
DEFAULT_HEIGHT = 640
DEFAULT_LENGTH = 49
DEFAULT_FPS = 16


def _find_one(workflow: dict[str, Any], class_type: str) -> str:
    matches = [
        str(nid)
        for nid, node in workflow.items()
        if isinstance(node, dict) and node.get("class_type") == class_type
    ]
    if len(matches) != 1:
        raise ValueError(
            f"Wan T2V workflow requires exactly one {class_type} node; found {len(matches)}"
        )
    return matches[0]


def _find_prompt_node(workflow: dict[str, Any], kind: str) -> str:
    needle = kind.lower()
    for nid, node in workflow.items():
        if not isinstance(node, dict) or node.get("class_type") != "CLIPTextEncode":
            continue
        title = str((node.get("_meta") or {}).get("title") or "").lower()
        if needle in title:
            return str(nid)
    raise ValueError(f"Wan T2V workflow has no {kind} prompt node")


def _validate_native_wan_t2v(workflow: dict[str, Any]) -> None:
    forbidden = {"LoadImage", "WanImageToVideo", "WanFirstLastFrameToVideo"}
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        inputs_text = json.dumps(node.get("inputs") or {}).lower()
        if class_type in forbidden or "qwen" in class_type.lower() or "qwen" in inputs_text:
            raise ValueError(
                f"Workflow is not native Wan T2V: forbidden node/model {class_type!r}"
            )


def _patch_workflow(
    api_workflow: dict[str, Any],
    *,
    prompt: str,
    negative_prompt: str | None,
    width: int,
    height: int,
    length: int,
    fps: int,
    seed: int | None = None,
) -> dict[str, Any]:
    w = deepcopy(api_workflow)
    _validate_native_wan_t2v(w)
    latent_id = _find_one(w, "EmptyHunyuanLatentVideo")
    video_id = _find_one(w, "CreateVideo")
    positive_id = _find_prompt_node(w, "positive")
    negative_id = _find_prompt_node(w, "negative")

    latent = w[latent_id].setdefault("inputs", {})
    latent["width"] = int(width)
    latent["height"] = int(height)
    latent["length"] = int(length)
    w[video_id].setdefault("inputs", {})["fps"] = float(fps)
    w[positive_id].setdefault("inputs", {})["text"] = str(prompt)
    if negative_prompt is not None:
        w[negative_id].setdefault("inputs", {})["text"] = str(negative_prompt)

    effective_seed = int(seed) if seed is not None else secrets.randbelow(2**63)
    for node in w.values():
        if (
            isinstance(node, dict)
            and node.get("class_type") == "KSamplerAdvanced"
            and (node.get("inputs") or {}).get("add_noise") == "enable"
        ):
            node.setdefault("inputs", {})["noise_seed"] = effective_seed
    return w


def _positive_int(task: dict[str, Any], key: str, default: int) -> int:
    try:
        value = int(task.get(key, default))
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{key} must be positive")
    return value


def _parse_bool(value: Any, *, name: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(int(value))
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off", ""}:
        return False
    raise ValueError(f"invalid {name} value: {value!r}")


def effective_individual_frames(task: dict[str, Any]) -> bool:
    if "individual_frames" in task:
        return _parse_bool(task["individual_frames"], name="individual_frames")
    return individual_frames_default


def run_t2v_job(
    task: dict[str, Any],
    *,
    workflows: dict[str, Any],
    server_address: str,
    individual_frames: bool = False,
) -> dict[str, Any]:
    out: dict[str, Any] = {"results": []}
    try:
        prompt = str(task.get("prompt") or task.get("positive_prompt") or "").strip()
        if not prompt:
            raise ValueError("prompt must be non-empty")
        negative = task.get("negative_prompt")
        negative_prompt = str(negative) if negative is not None else None
        width = _positive_int(task, "width", DEFAULT_WIDTH)
        height = _positive_int(task, "height", DEFAULT_HEIGHT)
        length = _positive_int(task, "length", DEFAULT_LENGTH)
        fps = _positive_int(task, "fps", DEFAULT_FPS)
        seed_raw = task.get("seed")
        seed = int(seed_raw) if seed_raw is not None else None

        api = workflows.get(API_KEY)
        if not isinstance(api, dict):
            raise RuntimeError(f"Workflow {API_KEY!r} is not loaded")
        workflow = _patch_workflow(
            api,
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            length=length,
            fps=fps,
            seed=seed,
        )
        prompt_id = task_queue(workflow, server_address)
        waiting_for_results(prompt_id, server_address, timeout_seconds=TIMEOUT)
        history = fetch_comfy_history(server_address, prompt_id)
        local_path = first_video_output_path(history, prompt_id, LOCAL_OUTPUT_DIR)
        if not local_path:
            raise RuntimeError("Wan T2V returned no video output")

        result: dict[str, Any] = {"length": length, "fps": fps}
        if individual_frames:
            frame_dir = osp.join(
                LOCAL_OUTPUT_DIR, "t2v_frames", uuid.uuid4().hex
            )
            paths = extract_video_frames_to_pngs(local_path, frame_dir)
            result["frame_urls"] = [
                view_or_s3_url_for_output_file(path, server_address=server_address)
                for path in paths
            ]
        else:
            result["url"] = view_or_s3_url_for_output_file(
                local_path, server_address=server_address
            )
        out["results"].append(result)
    except Exception as exc:
        logger.error("Wan T2V job failed: %s", exc)
        out["error"] = str(exc)
    return out


@timing_decorator
def handler(job_input: dict[str, Any]) -> dict[str, Any]:
    response: dict[str, Any] = {
        "created_at": int(time.time()),
        "queued_at": int(time.time()),
        "results": [],
        "error": None,
    }
    try:
        gpu_error, gpu_detail = gpu_preflight()
        if gpu_error:
            response["error"] = gpu_error
            return response
        logger.info("[gpu-preflight] OK (%s)", gpu_detail)
        task = job_input.get("input")
        if not isinstance(task, dict):
            response["error"] = "Missing or invalid job input"
            return response
        body = run_t2v_job(
            task,
            workflows=workflows,
            server_address=local_servers.get("default", "127.0.0.1:8188"),
            individual_frames=effective_individual_frames(task),
        )
        response["error"] = body.get("error")
        response["results"] = body.get("results", [])
    except TimeoutError:
        response["error"] = "Task timed out"
    except Exception as exc:
        response["error"] = str(exc)
    return response


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Native Wan 2.2 14B T2V Lightning")
    parser.add_argument("--test-mode", action="store_true")
    parser.add_argument("--enable-default", action="store_true")
    parser.add_argument("--default-port", type=int, default=8188)
    parser.add_argument("--prompt", type=str)
    parser.add_argument("--negative-prompt", type=str, default=None)
    parser.add_argument("--width", type=int, default=DEFAULT_WIDTH)
    parser.add_argument("--height", type=int, default=DEFAULT_HEIGHT)
    parser.add_argument("--length", type=int, default=DEFAULT_LENGTH)
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--individual-frames", action="store_true")
    return parser.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    prompt = str(args.prompt or "").strip()
    if not prompt:
        print("ERROR: --prompt required in test mode", file=sys.stderr)
        raise SystemExit(1)
    local_servers.setdefault("default", f"127.0.0.1:{args.default_port}")
    gpu_error, _detail = gpu_preflight()
    if gpu_error:
        print("ERROR: " + gpu_error, file=sys.stderr)
        raise SystemExit(1)
    if not wait_for_service_ready(local_servers["default"]):
        print("ERROR: ComfyUI not reachable at " + local_servers["default"], file=sys.stderr)
        raise SystemExit(1)
    task: dict[str, Any] = {
        "prompt": prompt,
        "width": args.width,
        "height": args.height,
        "length": args.length,
        "fps": args.fps,
        "individual_frames": args.individual_frames,
    }
    if args.negative_prompt is not None:
        task["negative_prompt"] = args.negative_prompt
    if args.seed is not None:
        task["seed"] = args.seed
    print(json.dumps(handler({"input": task}), indent=2))


def main() -> None:
    global individual_frames_default
    args = _parse_args()
    individual_frames_default = bool(
        args.individual_frames
        or os.environ.get("T2V_INDIVIDUAL_FRAMES", "").strip().lower()
        in {"1", "true", "yes", "y", "on"}
    )
    if args.enable_default:
        local_servers["default"] = f"127.0.0.1:{args.default_port}"
    load_download_cache()
    if args.test_mode:
        _run_test_mode(args)
    else:
        if runpod is None:
            raise RuntimeError("runpod is not installed; install it or use --test-mode")
        runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
