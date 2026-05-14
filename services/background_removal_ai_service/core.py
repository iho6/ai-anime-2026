"""Queue ComfyUI API workflow: LoadImage → RMBG → SaveImage (ComfyUI-RMBG)."""

from __future__ import annotations

import os.path as osp
from copy import deepcopy
from typing import Any

from services.utils import task_queue

_API_KEY = "rmbg2_0_api"


def _patch_workflow(
    workflow: dict[str, Any],
    *,
    image_input_ref: str,
    rmbg_overrides: dict[str, Any] | None,
) -> dict[str, Any]:
    w = deepcopy(workflow)
    rmbg_nid: str | None = None
    load_nid: str | None = None

    for nid, node in w.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        if ct == "LoadImage":
            load_nid = nid
            node.setdefault("inputs", {})["image"] = image_input_ref
        elif ct == "RMBG":
            rmbg_nid = nid

    if load_nid is None:
        raise ValueError("Workflow has no LoadImage node")
    if rmbg_nid is None:
        raise ValueError("Workflow has no RMBG node")

    rmbg_inp = w[rmbg_nid].setdefault("inputs", {})
    if rmbg_overrides:
        for k, v in rmbg_overrides.items():
            if k == "image":
                continue
            rmbg_inp[k] = v
    rmbg_inp["image"] = [load_nid, 0]

    for _nid, node in w.items():
        if not isinstance(node, dict) or node.get("class_type") != "SaveImage":
            continue
        inp = node.setdefault("inputs", {})
        imgs = inp.get("images")
        if isinstance(imgs, list) and len(imgs) >= 2:
            inp["images"] = [rmbg_nid, 0]

    return w


def run_rembg_workflow(
    image_input_ref: str,
    workflows: dict[str, Any],
    server_address: str,
    *,
    rmbg_overrides: dict[str, Any] | None = None,
) -> str:
    """
    Copy ``workflows[rmbg2_0_api]``, set LoadImage filename/ref, optional RMBG
    input overrides, and queue on ComfyUI. Returns prompt_id.
    """
    api = workflows.get(_API_KEY)
    if not api:
        raise ValueError(
            f"Missing workflow {_API_KEY!r}; add workflows/{_API_KEY}.json"
        )
    w = _patch_workflow(
        api,
        image_input_ref=(
            osp.basename(image_input_ref)
            if osp.isfile(image_input_ref)
            else str(image_input_ref).strip()
        ),
        rmbg_overrides=rmbg_overrides,
    )
    return task_queue(w, server_address)
