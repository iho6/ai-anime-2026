"""
Wan 2.2 14B image-to-video — RunPod serverless + local --test-mode.
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
    extract_video_frames_to_pngs,
    fetch_comfy_history,
    find_first_node_id,
    first_video_output_path,
    gpu_preflight,
    load_download_cache,
    load_workflows,
    normalize_image_urls,
    resolve_to_comfy_input_ref,
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
logger.info("Loaded %s workflow(s): %s", len(workflows), list(workflows.keys()))

local_servers: dict[str, str] = {}
convert_local_to_url = False
individual_frames_default = False

API_KEY = "video_wan2_2_14B_i2v"

DEFAULT_LENGTH = 121
DEFAULT_WIDTH = 640
DEFAULT_HEIGHT = 640


def _find_wan_i2v_nodes(workflow: dict[str, Any]) -> tuple[str, str]:
    wan_nid: str | None = None
    for nid, node in workflow.items():
        if isinstance(node, dict) and node.get("class_type") == "WanImageToVideo":
            wan_nid = str(nid)
            break
    if not wan_nid:
        raise ValueError("Workflow has no WanImageToVideo node")

    inp = workflow[wan_nid].get("inputs") or {}
    start_ref = inp.get("start_image")
    if not (isinstance(start_ref, list) and len(start_ref) >= 1):
        raise ValueError("WanImageToVideo missing start_image link")
    load_nid = str(start_ref[0])
    n = workflow.get(load_nid)
    if not isinstance(n, dict) or n.get("class_type") != "LoadImage":
        raise ValueError(f"Expected LoadImage at node {load_nid}")
    return wan_nid, load_nid


def _find_clip_encode_by_title_contains(
    workflow: dict[str, Any], *, needle: str
) -> str | None:
    needle_l = needle.lower()
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "CLIPTextEncode":
            continue
        meta = node.get("_meta") or {}
        title = str(meta.get("title") or "").lower()
        if needle_l in title and "text" in (node.get("inputs") or {}):
            return str(nid)
    return None


def _find_primitive_by_title(
    workflow: dict[str, Any],
    title: str,
    *,
    class_type: str | None = None,
) -> str | None:
    primitive_types = {
        "PrimitiveInt", "PrimitiveFloat", "PrimitiveBoolean", "PrimitiveString",
    }
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type") or ""
        if class_type:
            if ct != class_type:
                continue
        elif ct not in primitive_types:
            continue
        meta = node.get("_meta") or {}
        if str(meta.get("title") or "") == title:
            return str(nid)
    return None


def _find_ksampler_with_noise(workflow: dict[str, Any]) -> str | None:
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "KSamplerAdvanced":
            continue
        if (node.get("inputs") or {}).get("add_noise") == "enable":
            return str(nid)
    return None


def _patch_workflow(
    api_workflow: dict[str, Any],
    *,
    image_ref: str,
    width: int,
    height: int,
    length: int,
    positive_prompt: str | None,
    negative_prompt: str | None,
    steps: int | None,
    cfg: float | None,
    seed: int | None,
    fps: int | None,
    use_lora: bool | None,
) -> dict[str, Any]:
    w = deepcopy(api_workflow)
    wan_nid, load_nid = _find_wan_i2v_nodes(w)

    img = str(image_ref).strip()
    if osp.isfile(img):
        img = osp.basename(img)
    w[load_nid].setdefault("inputs", {})["image"] = img

    wan_in = w[wan_nid].setdefault("inputs", {})
    wan_in["width"] = int(width)
    wan_in["height"] = int(height)
    wan_in["length"] = int(length)

    pos_nid = _find_clip_encode_by_title_contains(w, needle="positive")
    if pos_nid and positive_prompt is not None:
        w[pos_nid].setdefault("inputs", {})["text"] = str(positive_prompt)

    neg_nid = _find_clip_encode_by_title_contains(w, needle="negative")
    if neg_nid and negative_prompt is not None:
        w[neg_nid].setdefault("inputs", {})["text"] = str(negative_prompt)

    if use_lora is not None:
        lora_nid = _find_primitive_by_title(
            w, "Enable 4steps LoRA?", class_type="PrimitiveBoolean"
        )
        if lora_nid:
            w[lora_nid].setdefault("inputs", {})["value"] = bool(use_lora)

    steps_nid = _find_primitive_by_title(w, "Steps", class_type="PrimitiveInt")
    if steps_nid and steps is not None:
        candidates = [
            nid for nid, node in w.items()
            if isinstance(node, dict)
            and node.get("class_type") == "PrimitiveInt"
            and str((node.get("_meta") or {}).get("title") or "") == "Steps"
        ]
        normal_nid = max(
            candidates,
            key=lambda nid: (w[nid].get("inputs") or {}).get("value", 0),
            default=None,
        )
        if normal_nid:
            w[normal_nid].setdefault("inputs", {})["value"] = int(steps)

    if cfg is not None:
        cfg_candidates = [
            nid for nid, node in w.items()
            if isinstance(node, dict)
            and node.get("class_type") == "PrimitiveFloat"
            and str((node.get("_meta") or {}).get("title") or "") == "CFG"
        ]
        normal_cfg_nid = max(
            cfg_candidates,
            key=lambda nid: (w[nid].get("inputs") or {}).get("value", 0),
            default=None,
        )
        if normal_cfg_nid:
            w[normal_cfg_nid].setdefault("inputs", {})["value"] = float(cfg)

    ks_nid = _find_ksampler_with_noise(w)
    if ks_nid and seed is not None:
        w[ks_nid].setdefault("inputs", {})["noise_seed"] = int(seed)

    create_vid = find_first_node_id(w, "CreateVideo")
    if create_vid and fps is not None:
        w[create_vid].setdefault("inputs", {})["fps"] = int(fps)

    return w


def _parse_lengths(task: dict) -> list[int] | None:
    raw = task.get("lengths")
    if raw is None:
        single = task.get("length")
        if single is not None:
            return [int(single)]
        return None
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.replace(",", " ").split() if p.strip()]
        return [int(p) for p in parts]
    if isinstance(raw, list):
        return [int(x) for x in raw]
    raise ValueError("lengths must be a list of integers or comma-separated string")


def align_lengths_for_images(
    lengths: list[int] | None, n_jobs: int, *, default: int = DEFAULT_LENGTH
) -> list[int]:
    raw = list(lengths) if lengths else []
    if n_jobs <= 0:
        return []
    if len(raw) == n_jobs:
        return raw
    if len(raw) > n_jobs:
        logger.warning(
            "Got %d length value(s) for %d image(s); using the first %d.",
            len(raw), n_jobs, n_jobs,
        )
        return raw[:n_jobs]
    logger.warning(
        "Got %d length value(s) for %d image(s); padding remaining with %s.",
        len(raw), n_jobs, raw[-1] if raw else default,
    )
    out = list(raw)
    fill = raw[-1] if raw else default
    while len(out) < n_jobs:
        out.append(fill)
    return out


def _parse_optional_int(task: dict, key: str) -> int | None:
    if key not in task:
        return None
    v = task[key]
    if v is None or (isinstance(v, str) and not str(v).strip()):
        return None
    return int(v)


def _parse_optional_float(task: dict, key: str) -> float | None:
    if key not in task:
        return None
    v = task[key]
    if v is None or (isinstance(v, str) and not str(v).strip()):
        return None
    return float(v)


def _parse_optional_bool(task: dict, key: str) -> bool | None:
    if key not in task:
        return None
    v = task[key]
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return bool(int(v))
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "y", "on"):
        return True
    if s in ("0", "false", "no", "n", "off", ""):
        return False
    raise ValueError(f"invalid bool value for {key!r}: {v!r}")


def run_img2video_job(
    task: dict,
    *,
    workflows: dict[str, Any],
    server_address: str,
    individual_frames: bool = False,
) -> dict[str, Any]:
    out: dict[str, Any] = {"results": []}
    try:
        image_urls = normalize_image_urls(task)
        n_img = len(image_urls)
        if n_img < 1:
            raise ValueError("At least one image is required")

        lengths_in = _parse_lengths(task)
        lengths = align_lengths_for_images(lengths_in, n_img, default=DEFAULT_LENGTH)

        width = _parse_optional_int(task, "width")
        height = _parse_optional_int(task, "height")
        w_px = int(width) if width is not None else DEFAULT_WIDTH
        h_px = int(height) if height is not None else DEFAULT_HEIGHT

        pos = task.get("positive_prompt")
        if pos is not None:
            pos = str(pos).strip() or None
        neg = task.get("negative_prompt")
        if neg is not None:
            neg = str(neg).strip() or None

        steps = _parse_optional_int(task, "steps")
        cfg = _parse_optional_float(task, "cfg")
        seed = _parse_optional_int(task, "seed")
        fps = _parse_optional_int(task, "fps")
        use_lora = _parse_optional_bool(task, "use_lora")

        api = workflows.get(API_KEY)
        if not api:
            raise RuntimeError(
                f"Workflow {API_KEY!r} not loaded; add workflows/{API_KEY}.json"
            )

        for j, url in enumerate(image_urls):
            length = lengths[j]
            logger.info(
                "img2video image_index=%s length=%s width=%s height=%s use_lora=%s",
                j, length, w_px, h_px, use_lora,
            )
            try:
                ref = resolve_to_comfy_input_ref(
                    url,
                    server_address,
                    subfolder="anime2026_img2video_inputs",
                )
            except Exception as e:
                logger.error("Input resolve failed: %s", e)
                out["error"] = f"Failed to resolve image {j}: {e}"
                return out

            w = _patch_workflow(
                api,
                image_ref=ref,
                width=w_px,
                height=h_px,
                length=length,
                positive_prompt=pos,
                negative_prompt=neg,
                steps=steps,
                cfg=cfg,
                seed=seed,
                fps=fps,
                use_lora=use_lora,
            )
            try:
                pid = task_queue(w, server_address)
                waiting_for_results(pid, server_address, timeout_seconds=TIMEOUT)
                history = fetch_comfy_history(server_address, pid)
                local_path = first_video_output_path(history, pid, LOCAL_OUTPUT_DIR)
                if not local_path:
                    out["error"] = f"No video output for image_index {j}"
                    return out
                if individual_frames:
                    dest_dir = osp.join(
                        LOCAL_OUTPUT_DIR,
                        "img2video_frames",
                        f"img{j}_{uuid.uuid4().hex}",
                    )
                    try:
                        png_paths = extract_video_frames_to_pngs(local_path, dest_dir)
                    except RuntimeError as e:
                        out["error"] = f"Frame extraction failed for image_index {j}: {e}"
                        return out
                    frame_urls = [
                        view_or_s3_url_for_output_file(p, server_address=server_address)
                        for p in png_paths
                    ]
                    out["results"].append({
                        "image_index": j,
                        "length": length,
                        "frame_urls": frame_urls,
                    })
                else:
                    vurl = view_or_s3_url_for_output_file(
                        local_path, server_address=server_address
                    )
                    out["results"].append({
                        "image_index": j,
                        "length": length,
                        "url": vurl,
                    })
            except Exception as e:
                logger.error("image_index %s failed: %s", j, e)
                out["error"] = f"Workflow failed for image_index {j}: {e}"
                return out

        return out
    except ValueError as e:
        out["error"] = str(e)
        return out
    except Exception as e:
        logger.error("Job error: %s", e)
        out["error"] = str(e)
        return out


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
        body = run_img2video_job(
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
    p = argparse.ArgumentParser(
        description="Img2Video (Wan 2.2 14B I2V) AI service"
    )
    p.add_argument("--test-mode", action="store_true")
    p.add_argument("--enable-default", action="store_true")
    p.add_argument("--default-port", type=int, default=8188)
    p.add_argument(
        "--image-url",
        type=str,
        default=None,
        help=(
            "One image URL/path or JSON array for multiple images, e.g. "
            '\'["a.png","b.png"]\''
        ),
    )
    p.add_argument(
        "--length",
        type=str,
        default=None,
        help=(
            "Per-image frame length(s), comma-separated (default 121, must follow 4n+1: 25,29,…,121). "
            "e.g. 33 or 33,37,41 for multiple images"
        ),
    )
    p.add_argument(
        "--positive-prompt",
        type=str,
        default=None,
        help="Optional positive prompt (CLIP encode)",
    )
    p.add_argument(
        "--negative-prompt",
        type=str,
        default=None,
        help="Optional negative prompt (CLIP encode)",
    )
    p.add_argument(
        "--width",
        type=int,
        default=None,
        help="Optional width in px, must be multiple of 16 (default 640, max 1280)",
    )
    p.add_argument(
        "--height",
        type=int,
        default=None,
        help="Optional height in px, must be multiple of 16 (default 640, max 720)",
    )
    p.add_argument(
        "--use-lora",
        dest="use_lora",
        default=None,
        action=argparse.BooleanOptionalAction,
        help=(
            "Enable/disable the 4-step lightning LoRA (default: on). "
            "--no-use-lora switches to the full 20-step pipeline."
        ),
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
            "Decode each output video to PNGs under output/img2video_frames/ and "
            "return frame_urls per image (overridable per job via input.individual_frames). "
            "Default can also be set with IMG2VIDEO_INDIVIDUAL_FRAMES=1."
        ),
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

    inp: dict[str, Any] = {**img_frag}
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
    if args.negative_prompt:
        inp["negative_prompt"] = args.negative_prompt
    if args.width is not None:
        inp["width"] = args.width
    if args.height is not None:
        inp["height"] = args.height
    if args.use_lora is not None:
        inp["use_lora"] = args.use_lora

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
        inp, local_servers["default"], subfolder="anime2026_img2video_test"
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
    env_if = os.environ.get("IMG2VIDEO_INDIVIDUAL_FRAMES", "").strip().lower() in (
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
        logger.info("Starting RunPod serverless (img2video Wan 2.2)...")
        runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
