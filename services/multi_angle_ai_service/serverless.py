"""
Multi-angle AI service serverless handler for RunPod (or local test mode).
Uses Qwen-Image-Edit + Multiple-Angles LoRA; one image, one angle per job.
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
import uuid
import urllib.parse
from copy import deepcopy

try:
    import runpod  # type: ignore
except ModuleNotFoundError:  # local --test-mode should still work
    runpod = None  # type: ignore

from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.multi_angle_ai_service import angle_library
from services.utils import (
    apply_upload_local_paths_to_comfy_in_task,
    apply_convert_local_paths_to_urls_in_task,
    delete_s3_object,
    download_input,
    fetch_comfy_history,
    gpu_preflight,
    load_download_cache,
    load_workflows,
    resolve_to_comfy_input_ref,
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

_ANGLES_PATH = osp.join(_SERVICE_DIR, "camera_angles.json")
_camera_angles: list = []
if osp.isfile(_ANGLES_PATH):
    with open(_ANGLES_PATH, "r", encoding="utf-8") as f:
        _camera_angles = json.load(f)
    logger.info("Loaded %s camera angles", len(_camera_angles))

_camera_angle_by_id: dict[int, dict] = {
    int(row["id"]): row
    for row in _camera_angles
    if isinstance(row, dict) and isinstance(row.get("id"), int)
}

local_servers: dict[str, str] = {}
supported_tasks: list = []
# When True, local file paths in image_url are uploaded to S3, then removed after the job.
convert_local_to_url = False


def append_default_multi_angle_background_instruction(prompt: str) -> str:
    """Append `, keep background blank white` after camera / user text (2511 multi-angle LoRA)."""
    phrase = "keep background blank white"
    p = (prompt or "").strip()
    if not p or phrase.lower() in p.lower():
        return p
    return f"{p}, {phrase}"


def _find_image_and_prompt_nodes(workflow):
    load_image_node = None
    prompt_node = None
    sampler_node = None
    prompt_candidates: list[tuple[str, str]] = []
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        inputs = node.get("inputs") or {}
        if ct == "LoadImage":
            load_image_node = nid
        if ct == "PrimitiveStringMultiline" and "value" in inputs:
            prompt_node = nid
        if ct == "KSampler":
            sampler_node = nid
        if "prompt" in inputs and isinstance(inputs.get("prompt"), str):
            prompt_candidates.append((nid, inputs["prompt"]))

    if prompt_node is None and prompt_candidates:
        # Prefer the positive-conditioning prompt node: look for "(Positive)"
        # in the title, or the candidate with a non-empty default prompt,
        # since the negative conditioning node typically has an empty prompt.
        for nid, txt in prompt_candidates:
            title = ((workflow[nid].get("_meta") or {}).get("title") or "")
            if "positive" in title.lower():
                prompt_node = nid
                break
        if prompt_node is None:
            nonempty = [(nid, txt) for nid, txt in prompt_candidates if txt.strip()]
            prompt_node = nonempty[0][0] if nonempty else prompt_candidates[0][0]

    return load_image_node, prompt_node, sampler_node


def run_multi_angle_workflow(image_input_ref, prompt_text, server_address=None):
    if server_address is None:
        server_address = local_servers.get("default", "127.0.0.1:8188")
    api_workflow = workflows.get("comfyui-workflow-multiple-angles_api")
    if not api_workflow:
        raise Exception(
            "comfyui-workflow-multiple-angles_api workflow not found. "
            "Export API format from ComfyUI and save as workflows/comfyui-workflow-multiple-angles_api.json"
        )
    w = deepcopy(api_workflow)
    load_nid, prompt_nid, sampler_nid = _find_image_and_prompt_nodes(w)
    image_ref = str(image_input_ref).strip()
    if osp.isfile(image_ref):
        image_ref = osp.basename(image_ref)
    if load_nid:
        w[load_nid]["inputs"]["image"] = image_ref
    if prompt_nid:
        if "value" in w[prompt_nid]["inputs"]:
            w[prompt_nid]["inputs"]["value"] = prompt_text
        elif "prompt" in w[prompt_nid]["inputs"]:
            w[prompt_nid]["inputs"]["prompt"] = prompt_text
    if sampler_nid and "seed" in w[sampler_nid].get("inputs", {}):
        w[sampler_nid]["inputs"]["seed"] = random.randint(0, 2**53)
    return task_queue(w, server_address)


def _resolve_prompt(task: dict, angle_id: int) -> str:
    if angle_id not in _camera_angle_by_id:
        valid = sorted(_camera_angle_by_id.keys())
        raise ValueError(
            f"angle_id {angle_id} not found in camera_angles.json "
            f"(valid: {valid[0]}–{valid[-1]}, {len(valid)} entries)"
        )
    override = task.get("prompt_text")
    if override is not None and str(override).strip():
        base = str(override).strip()
    else:
        base = str(_camera_angle_by_id[angle_id]["prompt_text"] or "").strip()
    return append_default_multi_angle_background_instruction(base)


@timing_decorator
def handler(job_input):
    """Job input: image_url, angle_id (0–95), optional prompt_text, optional library_key.

    Appends `, keep background blank white` to the resolved prompt unless that phrase is already present.
    """
    response = {
        "created_at": int(time.time()),
        "queued_at": int(time.time()),
        "variations": {
            "total_count": 1,
            "items": [
                {
                    "id": str(uuid.uuid4()),
                    "type": "multi_angle",
                    "created_at": int(time.time()),
                    "result": {"url": None},
                }
            ],
        },
    }
    staging_s3_keys: list[tuple[str, str]] = []

    try:
        task = job_input["input"]
        logger.info("Received task: %s", task)

        gpu_err, gpu_detail = gpu_preflight()
        if gpu_err:
            logger.error("[gpu-preflight] %s", gpu_err)
            response["error"] = gpu_err
            return response
        logger.info("[gpu-preflight] OK (%s)", gpu_detail)

        if "image_url" not in task:
            response["error"] = "Missing required parameter: image_url"
            return response

        if convert_local_to_url:
            staging_s3_keys = apply_convert_local_paths_to_urls_in_task(task)

        image_url = task["image_url"]
        angle_id = int(task.get("angle_id", 0))
        logger.info(
            "multi_angle Comfy input (post-convert if any): image_url=%s angle_id=%s",
            image_url,
            angle_id,
        )
        if angle_id not in _camera_angle_by_id:
            valid = sorted(_camera_angle_by_id.keys())
            response["error"] = (
                f"angle_id {angle_id} not found in camera_angles.json "
                f"(valid: {valid[0]}–{valid[-1]}, {len(valid)} entries)"
            )
            return response

        try:
            prompt_text = _resolve_prompt(task, angle_id)
        except ValueError as e:
            response["error"] = str(e)
            return response

        library_key = task.get("library_key")
        if library_key is not None:
            library_key = str(library_key).strip() or None

        try:
            image_ref = str(image_url or "").strip()
            addr = local_servers.get("default", "127.0.0.1:8188")

            # Keep a best-effort local path for optional angle-library saving.
            # Not all refs are local paths (e.g. Comfy refs like "subfolder/name.png").
            local_input_path: str | None = None
            try:
                from pathlib import Path
                from services.character_storage import DEFAULT_STORAGE_ROOT

                rel = Path(image_ref)
                target = (DEFAULT_STORAGE_ROOT / rel).resolve()
                root = DEFAULT_STORAGE_ROOT.resolve()
                if (root == target or root in target.parents) and target.is_file():
                    local_input_path = str(target)
            except Exception:
                pass
            if local_input_path is None:
                abs_path = osp.abspath(image_ref)
                if osp.isfile(abs_path):
                    local_input_path = abs_path

            # Use the shared resolver pipeline (same behavior as other services):
            # - remote refs (http(s), UUID) -> download -> upload to Comfy
            # - local file path -> upload to Comfy
            # - storage-relative path under DEFAULT_STORAGE_ROOT -> resolve -> upload
            # - otherwise treated as already a Comfy input ref and returned as-is
            comfy_input_ref = resolve_to_comfy_input_ref(
                image_ref, addr, subfolder="anime2026_multi_angle_inputs"
            )
        except Exception as e:
            logger.error(e)
            response["error"] = f"Failed to resolve image: {image_url}"
            return response

        try:
            prompt_id = run_multi_angle_workflow(
                comfy_input_ref, prompt_text, local_servers.get("default")
            )
            waiting_for_results(
                prompt_id, local_servers["default"], timeout_seconds=TIMEOUT
            )
            output_dir = LOCAL_OUTPUT_DIR
            history = fetch_comfy_history(local_servers["default"], prompt_id)
            outputs = (history.get(prompt_id) or {}).get("outputs") or {}
            out_filename = None
            for _nid, out in outputs.items():
                imgs = out.get("images")
                if imgs:
                    out_filename = imgs[0].get("filename")
                    break
            if out_filename and osp.isfile(osp.join(output_dir, out_filename)):
                local_out = osp.join(output_dir, out_filename)
                try:
                    if local_input_path:
                        angle_library.save_generation_to_library(
                            _SERVICE_DIR,
                            source_path=local_input_path,
                            angle_id=angle_id,
                            comfy_output_file=local_out,
                            library_key=library_key,
                        )
                except Exception as lib_e:
                    logger.warning("Angle library save failed: %s", lib_e)
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
                    output_url = f"http://{local_servers['default']}/view?filename={qfn}&type=output"
                response["variations"]["items"][0]["result"]["url"] = output_url
            else:
                response["error"] = "Workflow completed but output image not found"
        except Exception as e:
            logger.error(e)
            response["error"] = f"Workflow execution failed: {str(e)}"
            return response

        return response

    except TimeoutError:
        response["error"] = "Task timed out"
        return response
    except Exception as e:
        logger.error("Critical error: %s", str(e))
        response["error"] = str(e)
        return response
    finally:
        for bucket, key in staging_s3_keys:
            delete_s3_object(bucket, key)


def _parse_args():
    parser = argparse.ArgumentParser(description="Multi-angle AI Service")
    parser.add_argument(
        "--test-mode", action="store_true", help="Run handler once locally"
    )
    parser.add_argument(
        "--enable-default", action="store_true", help="Point default ComfyUI"
    )
    parser.add_argument("--default-port", type=int, default=8188, help="ComfyUI port")
    parser.add_argument("--image-url", type=str, default=None)
    parser.add_argument("--angle-id", type=int, default=0)
    parser.add_argument(
        "--prompt-text", type=str, default=None, help="Override angle prompt"
    )
    parser.add_argument("--library-key", type=str, default=None)
    parser.add_argument(
        "--convert-local-to-url",
        action="store_true",
        help=(
            "Upload local image_url paths to S3 so download_input can fetch them; "
            "delete those staging objects after the job (output result URL unchanged)."
        ),
    )
    return parser.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    if not args.image_url:
        print("ERROR: --image-url required in test mode")
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
            "ERROR: ComfyUI not reachable at", local_servers["default"], file=sys.stderr
        )
        sys.exit(1)
    inp = {
        "image_url": args.image_url,
        "angle_id": args.angle_id,
    }
    if args.prompt_text:
        inp["prompt_text"] = args.prompt_text
    if args.library_key:
        inp["library_key"] = args.library_key
    apply_upload_local_paths_to_comfy_in_task(
        inp, local_servers["default"], subfolder="anime2026_multi_angle_test"
    )
    result = handler({"input": inp})
    print(json.dumps(result, indent=2))


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
        supported_tasks.append("multi_angle")

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
