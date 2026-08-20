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
import uuid
from copy import deepcopy
from typing import Any

try:
    import runpod  # type: ignore
except ModuleNotFoundError:
    runpod = None  # type: ignore

from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.wan_video_dims import resolve_wan_job_dims
from services.utils import (
    apply_convert_local_paths_to_urls_in_task,
    apply_upload_local_paths_to_comfy_in_task,
    delete_s3_object,
    extract_video_frames_to_pngs,
    fetch_comfy_history,
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

API_KEY = "video_wan2_2_14B_flf2v_lightning_api"
DEFAULT_LENGTH = 121
DEFAULT_WIDTH = 1280
DEFAULT_HEIGHT = 1280


def _find_wan_flf_nodes(workflow: dict[str, Any]) -> tuple[str, str, str]:
    wan_nid: str | None = None
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") == "WanFirstLastFrameToVideo":
            wan_nid = nid
            break
    if not wan_nid:
        raise ValueError("Workflow has no WanFirstLastFrameToVideo node")

    inp = workflow[wan_nid].get("inputs") or {}
    start_ref = inp.get("start_image")
    end_ref = inp.get("end_image")
    if not (isinstance(start_ref, list) and len(start_ref) >= 1):
        raise ValueError("WanFirstLastFrameToVideo missing start_image link")
    if not (isinstance(end_ref, list) and len(end_ref) >= 1):
        raise ValueError("WanFirstLastFrameToVideo missing end_image link")
    start_nid = str(start_ref[0])
    end_nid = str(end_ref[0])

    for lid in (start_nid, end_nid):
        n = workflow.get(lid)
        if not isinstance(n, dict) or n.get("class_type") != "LoadImage":
            raise ValueError(f"Expected LoadImage at node {lid}")

    return wan_nid, start_nid, end_nid


def _patch_workflow(
    api_workflow: dict[str, Any],
    *,
    start_ref: str,
    end_ref: str,
    length: int,
    positive_prompt: str | None,
    width: int,
    height: int,
) -> dict[str, Any]:
    w = deepcopy(api_workflow)
    wan_nid, start_nid, end_nid = _find_wan_flf_nodes(w)

    s = str(start_ref).strip()
    e = str(end_ref).strip()
    if osp.isfile(s):
        s = osp.basename(s)
    if osp.isfile(e):
        e = osp.basename(e)
    w[start_nid].setdefault("inputs", {})["image"] = s
    w[end_nid].setdefault("inputs", {})["image"] = e
    wan_in = w[wan_nid].setdefault("inputs", {})
    wan_in["length"] = int(length)
    wan_in["width"] = int(width)
    wan_in["height"] = int(height)

    if positive_prompt is not None and str(positive_prompt).strip():
        text = str(positive_prompt).strip()
        for _nid, node in w.items():
            if not isinstance(node, dict):
                continue
            if node.get("class_type") != "CLIPTextEncode":
                continue
            meta = node.get("_meta") or {}
            title = str(meta.get("title") or "")
            inputs = node.setdefault("inputs", {})
            if "Positive" in title and "text" in inputs:
                inputs["text"] = text
                break

    return w


def _parse_frames_1based(task: dict) -> list[int]:
    raw = task.get("frames")
    if raw is None:
        raise ValueError(
            'Missing "frames": list of 1-based indices into image_urls (at least 2)'
        )
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.replace(",", " ").split() if p.strip()]
        frames = [int(p) for p in parts]
    elif isinstance(raw, list):
        frames = [int(x) for x in raw]
    else:
        raise ValueError("frames must be a list of integers or a comma-separated string")
    if len(frames) < 2:
        raise ValueError("frames must contain at least two indices for first/last pairing")
    return frames


def _parse_optional_int(task: dict, key: str) -> int | None:
    if key not in task:
        return None
    v = task[key]
    if v is None or (isinstance(v, str) and not str(v).strip()):
        return None
    return int(v)


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


def align_lengths_for_pairs(
    lengths: list[int] | None, n_pairs: int, *, default: int = DEFAULT_LENGTH
) -> list[int]:
    raw = list(lengths) if lengths else []
    if n_pairs <= 0:
        return []

    if len(raw) == n_pairs:
        return raw

    if len(raw) > n_pairs:
        logger.warning(
            "Got %d length value(s) for %d first-last pair(s); using the first %d.",
            len(raw),
            n_pairs,
            n_pairs,
        )
        return raw[:n_pairs]

    logger.warning(
        "Got %d length value(s) for %d first-last pair(s); padding remaining with %s.",
        len(raw),
        n_pairs,
        raw[-1] if raw else default,
    )
    out = list(raw)
    fill = raw[-1] if raw else default
    while len(out) < n_pairs:
        out.append(fill)
    return out


def consecutive_pairs_from_frames(
    frames_1based: list[int], n_images: int
) -> list[tuple[int, int, int]]:
    pairs: list[tuple[int, int, int]] = []
    for i in range(len(frames_1based) - 1):
        a1 = frames_1based[i]
        b1 = frames_1based[i + 1]
        if a1 < 1 or a1 > n_images or b1 < 1 or b1 > n_images:
            raise ValueError(
                f"frame index out of range: got {a1}, {b1} for {n_images} image(s) (1-based)"
            )
        pairs.append((i, a1 - 1, b1 - 1))
    return pairs


def run_flf2video_job(
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
        frames_1 = _parse_frames_1based(task)
        pairs_meta = consecutive_pairs_from_frames(frames_1, n_img)
        n_pairs = len(pairs_meta)

        lengths_in = _parse_lengths(task)
        lengths = align_lengths_for_pairs(lengths_in, n_pairs, default=DEFAULT_LENGTH)

        api = workflows.get(API_KEY)
        if not api:
            raise RuntimeError(
                f"Workflow {API_KEY!r} not loaded; add workflows/{API_KEY}.json"
            )

        pos = task.get("positive_prompt")
        if pos is not None:
            pos = str(pos).strip() or None

        width = _parse_optional_int(task, "width")
        height = _parse_optional_int(task, "height")

        for j, (_pair_idx, ia, ib) in enumerate(pairs_meta):
            length = lengths[j]
            url_a = image_urls[ia]
            url_b = image_urls[ib]
            w_px, h_px = resolve_wan_job_dims(
                width,
                height,
                url_a,
                url_b,
                fallback=(DEFAULT_WIDTH, DEFAULT_HEIGHT),
            )
            logger.info(
                "FLF2V pair %s: frame indices %s-%s (1-based), length=%s width=%s height=%s",
                j,
                frames_1[j],
                frames_1[j + 1],
                length,
                w_px,
                h_px,
            )
            try:
                ref_start = resolve_to_comfy_input_ref(
                    url_a,
                    server_address,
                    subfolder="anime2026_flf2video_inputs",
                )
                ref_end = resolve_to_comfy_input_ref(
                    url_b,
                    server_address,
                    subfolder="anime2026_flf2video_inputs",
                )
            except Exception as e:
                logger.error("Input resolve failed: %s", e)
                out["error"] = f"Failed to resolve images for pair {j}: {e}"
                return out

            w = _patch_workflow(
                api,
                start_ref=ref_start,
                end_ref=ref_end,
                length=length,
                positive_prompt=pos,
                width=w_px,
                height=h_px,
            )
            try:
                pid = task_queue(w, server_address)
                waiting_for_results(pid, server_address, timeout_seconds=TIMEOUT)
                history = fetch_comfy_history(server_address, pid)
                local_path = first_video_output_path(history, pid, LOCAL_OUTPUT_DIR)
                if not local_path:
                    out["error"] = (
                        f"No video output for pair {j} (frames {frames_1[j]}-{frames_1[j+1]})"
                    )
                    return out
                if individual_frames:
                    dest_dir = osp.join(
                        LOCAL_OUTPUT_DIR,
                        "flf2video_frames",
                        f"pair{j}_{uuid.uuid4().hex}",
                    )
                    try:
                        png_paths = extract_video_frames_to_pngs(local_path, dest_dir)
                    except RuntimeError as e:
                        out["error"] = (
                            f"Frame extraction failed for pair {j} "
                            f"(frames {frames_1[j]}-{frames_1[j + 1]}): {e}"
                        )
                        return out
                    frame_urls = [
                        view_or_s3_url_for_output_file(p, server_address=server_address)
                        for p in png_paths
                    ]
                    out["results"].append(
                        {
                            "pair_index": j,
                            "frame_start": frames_1[j],
                            "frame_end": frames_1[j + 1],
                            "length": length,
                            "frame_urls": frame_urls,
                        }
                    )
                else:
                    url = view_or_s3_url_for_output_file(
                        local_path, server_address=server_address
                    )
                    out["results"].append(
                        {
                            "pair_index": j,
                            "frame_start": frames_1[j],
                            "frame_end": frames_1[j + 1],
                            "length": length,
                            "url": url,
                        }
                    )
            except Exception as e:
                logger.error("Pair %s failed: %s", j, e)
                out["error"] = f"Workflow failed for pair {j}: {e}"
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
        body = run_flf2video_job(
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
            "Per-pair frame length(s), comma-separated (default 121). "
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
        "--width",
        type=int,
        default=None,
        help="Optional width in px, multiple of 16 (default: 1280 long-edge from source)",
    )
    p.add_argument(
        "--height",
        type=int,
        default=None,
        help="Optional height in px, multiple of 16 (default: 1280 long-edge from source)",
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
    if args.width is not None:
        inp["width"] = args.width
    if args.height is not None:
        inp["height"] = args.height

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
