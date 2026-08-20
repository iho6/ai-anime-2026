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
import uuid
import urllib.parse
import urllib.request
from copy import deepcopy
from typing import Any

try:
    import runpod  # type: ignore
except ModuleNotFoundError:  # local --test-mode should still work
    runpod = None  # type: ignore

from services import prompts
from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.qwen_image_dims import (
    snap_paths_to_shared_qwen_bucket,
)
from services.utils import (
    apply_upload_local_paths_to_comfy_in_task,
    apply_convert_local_paths_to_urls_in_task,
    delete_s3_object,
    gpu_preflight,
    load_download_cache,
    load_workflows,
    normalize_image_urls,
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

WORKFLOW_STEM = "image_qwen_image_edit_2509"

_QWEN_EDIT_ENCODER_NEG = "433:110"
_QWEN_EDIT_ENCODER_POS = "433:111"
_QWEN_EDIT_VAE_ENCODE = "433:88"
_QWEN_EDIT_KONTEXT_IDS = ("433:117", "433:118", "433:119")


def _load_image_node_sort_key(node_id: str) -> tuple[int, int | str]:
    if node_id.isdigit():
        return (0, int(node_id))
    return (1, node_id)


def _find_load_image_nodes_ordered(workflow: dict) -> list[str]:
    ids: list[str] = []
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") == "LoadImage":
            ids.append(str(nid))
    ids.sort(key=_load_image_node_sort_key)
    return ids


def rewire_qwen_edit_encode_without_kontext(workflow: dict) -> dict:
    """Point VAEEncode / Qwen encoders at LoadImage and drop FluxKontextImageScale.

    Flux 1MP buckets would snap a 1328² still down to 1024².
    """
    load_ids = _find_load_image_nodes_ordered(workflow)
    if not load_ids:
        return workflow
    primary = load_ids[0]
    vae = workflow.get(_QWEN_EDIT_VAE_ENCODE)
    if isinstance(vae, dict):
        vae.setdefault("inputs", {})["pixels"] = [primary, 0]
    for enc_id in (_QWEN_EDIT_ENCODER_NEG, _QWEN_EDIT_ENCODER_POS):
        node = workflow.get(enc_id)
        if not isinstance(node, dict):
            continue
        inp = node.setdefault("inputs", {})
        inp["image1"] = [primary, 0]
        if len(load_ids) >= 2 and "image2" in inp:
            inp["image2"] = [load_ids[1], 0]
        if len(load_ids) >= 3 and "image3" in inp:
            inp["image3"] = [load_ids[2], 0]
    for nid in _QWEN_EDIT_KONTEXT_IDS:
        workflow.pop(nid, None)
    return workflow


def _find_prompt_node(workflow: dict) -> str | None:
    prompt_node = None
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs") or {}
        if node.get("class_type") == "PrimitiveStringMultiline" and "value" in inputs:
            prompt_node = nid
        if prompt_node is None and "prompt" in inputs and isinstance(
            inputs.get("prompt"), str
        ):
            prompt_node = nid
    return prompt_node


def _normalize_comfy_image_input_ref(ref: str) -> str:
    image_ref = str(ref).strip()
    if osp.isfile(image_ref):
        image_ref = osp.basename(image_ref)
    return image_ref


def _parse_auxiliary_image_urls(task: dict) -> list[str]:
    raw = task.get("auxiliary_image_urls")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("auxiliary_image_urls must be a list of strings")
    out: list[str] = []
    for x in raw:
        s = str(x).strip()
        if not s:
            raise ValueError("auxiliary_image_urls entries must be non-empty")
        out.append(s)
    if len(out) > 2:
        raise ValueError("auxiliary_image_urls supports at most 2 entries")
    return out


def load_catalog(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError("Prompt catalog must be a JSON array")
    return data


def catalog_text(catalog: list[dict], index: int) -> tuple[str, int | None]:
    if not isinstance(index, int) or index < 0 or index >= len(catalog):
        raise ValueError(
            f"Catalog index out of range: {index} (catalog has {len(catalog)} entries)"
        )
    row = catalog[index]
    text = row.get("prompt_text")
    if not text or not str(text).strip():
        raise ValueError(f"Missing prompt_text for catalog index {index}")
    cid = row.get("id")
    if isinstance(cid, int):
        return str(text).strip(), cid
    return str(text).strip(), index


def resolve_prompts_matrix(
    task: dict, service_dir: str, num_images: int
) -> tuple[list[list[str]], list[list[int | None]]]:
    src = (task.get("prompt_source") or "inline").strip().lower()

    if src == "inline":
        prompts = task.get("prompts")
        if prompts is None:
            raise ValueError('prompt_source "inline" requires prompts')
        if prompts and isinstance(prompts[0], str):
            if num_images != 1:
                raise ValueError(
                    "Flat prompts list only allowed for a single image; use nested lists for multiple images"
                )
            matrix = [[str(p).strip() for p in prompts]]
        else:
            matrix = []
            for row in prompts:
                if not isinstance(row, list):
                    raise ValueError("prompts must be a list of lists for multiple images")
                matrix.append([str(p).strip() for p in row])
        if len(matrix) != num_images:
            raise ValueError(
                f"prompts outer length ({len(matrix)}) must match number of images ({num_images})"
            )
        ids = [[None] * len(row) for row in matrix]
        return matrix, ids

    if src == "pose":
        cat_path = str(prompts.POSE_PROMPTS_PATH)
    elif src == "expression":
        cat_path = str(prompts.EXPRESSION_PROMPTS_PATH)
    elif src == "file":
        rel = task.get("prompt_catalog_path")
        if not rel or not str(rel).strip():
            raise ValueError(
                'prompt_source "file" requires prompt_catalog_path relative to service dir or absolute'
            )
        rel = str(rel).strip()
        cat_path = rel if osp.isabs(rel) else osp.join(service_dir, rel)
    else:
        raise ValueError(
            f'Unknown prompt_source "{src}"; use inline, pose, expression, or file'
        )

    if not osp.isfile(cat_path):
        raise ValueError(f"Prompt catalog not found: {cat_path}")

    catalog = load_catalog(cat_path)
    indices_per_image = task.get("indices_per_image")
    flat_indices = task.get("indices")

    if task.get("run_full_catalog"):
        flat_indices = list(range(len(catalog)))
        indices_per_image = None

    if indices_per_image is not None:
        if len(indices_per_image) != num_images:
            raise ValueError(
                "indices_per_image length must match number of images"
            )
        matrix = []
        id_rows: list[list[int | None]] = []
        for row in indices_per_image:
            texts = []
            id_row = []
            if not isinstance(row, list):
                raise ValueError("indices_per_image must be a list of lists")
            for idx in row:
                t, cid = catalog_text(catalog, int(idx))
                texts.append(t)
                id_row.append(cid)
            matrix.append(texts)
            id_rows.append(id_row)
        return matrix, id_rows

    if flat_indices is not None:
        if not isinstance(flat_indices, list):
            raise ValueError("indices must be a list of integers")
        row_texts = []
        id_row = []
        for idx in flat_indices:
            t, cid = catalog_text(catalog, int(idx))
            row_texts.append(t)
            id_row.append(cid)
        matrix = [list(row_texts) for _ in range(num_images)]
        id_rows = [list(id_row) for _ in range(num_images)]
        return matrix, id_rows

    raise ValueError(
        "Catalog mode requires indices, indices_per_image, or run_full_catalog"
    )


def run_one_prompt(
    api_workflow: dict,
    image_input_ref: str,
    prompt_text: str,
    server_address: str,
    *,
    auxiliary_comfy_refs: list[str] | None = None,
    cfg: float | None = None,
) -> str:
    w = deepcopy(api_workflow)
    rewire_qwen_edit_encode_without_kontext(w)
    load_ids = _find_load_image_nodes_ordered(w)
    prompt_nid = _find_prompt_node(w)
    if not load_ids or not prompt_nid:
        raise RuntimeError("Workflow missing LoadImage or prompt node")

    w[load_ids[0]]["inputs"]["image"] = _normalize_comfy_image_input_ref(
        image_input_ref
    )
    if cfg is not None:
        w.setdefault("433:3", {}).setdefault("inputs", {})["cfg"] = float(cfg)

    aux = list(auxiliary_comfy_refs or [])[:2]
    if aux:
        if len(load_ids) < 1 + len(aux):
            raise RuntimeError(
                "Workflow needs one LoadImage per primary + auxiliary image "
                f"(have {len(load_ids)} LoadImage nodes, need {1 + len(aux)})"
            )
        for i, ref in enumerate(aux):
            w[load_ids[i + 1]]["inputs"]["image"] = _normalize_comfy_image_input_ref(
                ref
            )
        for enc in (_QWEN_EDIT_ENCODER_NEG, _QWEN_EDIT_ENCODER_POS):
            node = w.get(enc)
            if not isinstance(node, dict):
                continue
            inp = node.setdefault("inputs", {})
            inp["image2"] = [load_ids[1], 0]
            if len(aux) >= 2:
                inp["image3"] = [load_ids[2], 0]
            else:
                inp.pop("image3", None)

    if "value" in w[prompt_nid]["inputs"]:
        w[prompt_nid]["inputs"]["value"] = prompt_text
    elif "prompt" in w[prompt_nid]["inputs"]:
        w[prompt_nid]["inputs"]["prompt"] = prompt_text
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


def run_image_edit_job(
    task: dict,
    *,
    service_dir: str,
    workflows: dict,
    server_address: str,
) -> dict[str, Any]:
    out: dict[str, Any] = {"results": []}
    try:
        image_urls = normalize_image_urls(task)
        prompts_matrix, catalog_id_matrix = resolve_prompts_matrix(
            task, service_dir, len(image_urls)
        )

        api = workflows.get(WORKFLOW_STEM)
        if not api:
            raise RuntimeError(
                f"Workflow {WORKFLOW_STEM} not loaded; add workflows/{WORKFLOW_STEM}.json"
            )

        cfg = task.get("cfg")
        if cfg is not None:
            cfg = float(cfg)

        aux_url_list = _parse_auxiliary_image_urls(task)
        temps_to_delete: list[str] = []
        try:
            use_s3 = services_use_s3()

            for img_idx, image_url in enumerate(image_urls):
                snapped_primary, snapped_aux, temps = snap_paths_to_shared_qwen_bucket(
                    str(image_url), list(aux_url_list)
                )
                temps_to_delete.extend(temps)
                try:
                    aux_comfy_refs: list[str] = []
                    for aux_u in snapped_aux:
                        aux_comfy_refs.append(
                            resolve_to_comfy_input_ref(
                                aux_u,
                                server_address,
                                subfolder="anime2026_image_edit_inputs",
                            )
                        )
                except Exception as e:
                    logger.error("Auxiliary input resolve failed: %s", e)
                    out["error"] = f"Failed to resolve auxiliary image: {e}"
                    return out

                try:
                    comfy_image_ref = resolve_to_comfy_input_ref(
                        snapped_primary,
                        server_address,
                        subfolder="anime2026_image_edit_inputs",
                    )
                except Exception as e:
                    logger.error("Input resolve failed: %s", e)
                    out["error"] = f"Failed to resolve image: {image_url}"
                    return out

                row = prompts_matrix[img_idx]
                id_row = catalog_id_matrix[img_idx]
                for p_idx, prompt_text in enumerate(row):
                    try:
                        pid = run_one_prompt(
                            api,
                            comfy_image_ref,
                            prompt_text,
                            server_address,
                            auxiliary_comfy_refs=aux_comfy_refs or None,
                            cfg=cfg,
                        )
                        waiting_for_results(pid, server_address, timeout_seconds=TIMEOUT)
                        with urllib.request.urlopen(
                            f"http://{server_address}/history/{pid}"
                        ) as resp:
                            history = json.loads(resp.read().decode("utf-8"))
                        fn = get_first_output_filename(
                            history, pid, LOCAL_OUTPUT_DIR
                        )
                        if not fn:
                            out["error"] = (
                                f"No output image for image {img_idx} prompt {p_idx}"
                            )
                            return out
                        local_file = osp.join(LOCAL_OUTPUT_DIR, fn)
                        if use_s3:
                            url = upload_to_s3(local_file, str(uuid.uuid4()))
                        else:
                            qfn = urllib.parse.quote(fn)
                            url = f"http://{server_address}/view?filename={qfn}&type=output"
                        entry = {
                            "image_index": img_idx,
                            "prompt_index": p_idx,
                            "prompt": prompt_text,
                            "url": url,
                        }
                        cid = id_row[p_idx] if p_idx < len(id_row) else None
                        if cid is not None:
                            entry["catalog_id"] = cid
                        out["results"].append(entry)
                    except Exception as e:
                        logger.error(
                            "Run failed image=%s prompt=%s: %s", img_idx, p_idx, e
                        )
                        out["error"] = (
                            f"Workflow failed for image {img_idx} prompt {p_idx}: {e}"
                        )
                        return out

            return out
        finally:
            for tmp in temps_to_delete:
                try:
                    if tmp and osp.isfile(tmp):
                        os.unlink(tmp)
                except OSError:
                    pass
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
        body = run_image_edit_job(
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
    parser.add_argument(
        "--cfg",
        type=float,
        default=None,
        help="Override KSampler cfg scale (default: 1.0 from workflow).",
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

    if args.cfg is not None:
        inp["cfg"] = args.cfg

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
