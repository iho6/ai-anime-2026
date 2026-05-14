"""Resolve prompts from inline or JSON catalogs; run Comfy workflow per (image, prompt)."""

from __future__ import annotations

import json
import logging
import os
import os.path as osp
import uuid
from copy import deepcopy
from typing import Any

import urllib.request
import urllib.parse

from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.utils import (
    normalize_image_urls,
    resolve_to_comfy_input_ref,
    task_queue,
    upload_to_s3,
    waiting_for_results,
)

logger = logging.getLogger("anime2026_services")

WORKFLOW_STEM = "image_qwen_image_edit_2509"

# TextEncodeQwenImageEditPlus (negative / positive) and auxiliary FluxKontext scales
# for image2 / image3 — must match workflows/image_qwen_image_edit_2509.json.
_QWEN_EDIT_ENCODER_NEG = "433:110"
_QWEN_EDIT_ENCODER_POS = "433:111"
_QWEN_EDIT_SCALE_AUX2 = "433:118"
_QWEN_EDIT_SCALE_AUX3 = "433:119"


def _load_image_node_sort_key(node_id: str) -> tuple[int, int | str]:
    """
    Sort LoadImage node ids: pure integers numerically (78 < 79), else lexicographic
    after numeric ids.
    """
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
    """
    Returns (prompts_per_image, catalog_ids_per_image) where catalog_ids align for metadata.
    For inline mode, catalog ids are None per cell.
    """
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

    # Catalog modes
    if src == "pose":
        cat_path = osp.join(service_dir, "pose_prompts.json")
    elif src == "expression":
        cat_path = osp.join(service_dir, "expression_prompts.json")
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
) -> str:
    w = deepcopy(api_workflow)
    load_ids = _find_load_image_nodes_ordered(w)
    prompt_nid = _find_prompt_node(w)
    if not load_ids or not prompt_nid:
        raise RuntimeError("Workflow missing LoadImage or prompt node")

    w[load_ids[0]]["inputs"]["image"] = _normalize_comfy_image_input_ref(
        image_input_ref
    )

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
            inp["image2"] = [_QWEN_EDIT_SCALE_AUX2, 0]
            if len(aux) >= 2:
                inp["image3"] = [_QWEN_EDIT_SCALE_AUX3, 0]
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
    """
    Returns dict with keys: results (list), error (optional str).
    Each result: image_index, prompt_index, prompt, url, catalog_id (optional).
    """
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

        aux_url_list = _parse_auxiliary_image_urls(task)
        aux_comfy_refs: list[str] = []
        for aux_u in aux_url_list:
            try:
                aux_comfy_refs.append(
                    resolve_to_comfy_input_ref(
                        aux_u,
                        server_address,
                        subfolder="anime2026_image_edit_inputs",
                    )
                )
            except Exception as e:
                logger.error("Auxiliary input resolve failed: %s", e)
                out["error"] = f"Failed to resolve auxiliary image: {aux_u}"
                return out

        for img_idx, image_url in enumerate(image_urls):
            try:
                comfy_image_ref = resolve_to_comfy_input_ref(
                    image_url, server_address, subfolder="anime2026_image_edit_inputs"
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
                    use_s3 = (os.environ.get("SERVICES_USE_S3") or "").strip().lower() in {
                        "1",
                        "true",
                        "yes",
                        "y",
                        "on",
                    }
                    if use_s3:
                        upload_name = str(uuid.uuid4())
                        url = upload_to_s3(local_file, upload_name)
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
    except ValueError as e:
        out["error"] = str(e)
        return out
    except Exception as e:
        logger.error("Job error: %s", e)
        out["error"] = str(e)
        return out
