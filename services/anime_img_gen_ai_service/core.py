"""Anima preview T2I: prepend fixed anime quality tag to user prompts; run Comfy workflow."""

from __future__ import annotations

import json
import logging
import os
import os.path as osp
import secrets
import uuid
from copy import deepcopy
from typing import Any

import urllib.request
import urllib.parse

from services.constant import LOCAL_OUTPUT_DIR, TIMEOUT
from services.utils import (
    summarize_comfy_history_entry,
    task_queue,
    upload_to_s3,
    waiting_for_results,
)

logger = logging.getLogger("anime2026_services")

WORKFLOW_STEM = "image_anima_preview"
POSITIVE_NODE_ID = "11"
NEGATIVE_NODE_ID = "12"

# Prepended to every user prompt (node 11). User supplies only scene/subject description.
DEFAULT_STYLE_PREFIX = (
    "masterpiece, best quality, score_7, safe. anime, plain white background, full body view, "
)


def _should_upload_to_s3() -> bool:
    """
    Local/dev runs should not require AWS credentials.
    Set SERVICES_USE_S3=1 to keep the legacy behavior (upload results and return `url`).
    """
    v = (os.environ.get("SERVICES_USE_S3") or "").strip().lower()
    return v in {"1", "true", "yes", "y", "on"}


def _coerce_task_bool(value: Any, *, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(int(value))
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "y", "on")
    return default


def build_positive_prompt(user_prompt: str, style_prefix: str | None = None) -> str:
    prefix = (style_prefix or DEFAULT_STYLE_PREFIX).strip()
    if prefix and not prefix.endswith((" ", ",")):
        prefix = prefix + " "
    elif prefix.endswith(","):
        prefix = prefix + " "
    body = (user_prompt or "").strip()
    return prefix + body


def normalize_user_prompts(task: dict) -> list[str]:
    if "prompts" in task:
        p = task["prompts"]
        if isinstance(p, str):
            return [p.strip()] if p.strip() else []
        if not isinstance(p, list) or not p:
            raise ValueError("prompts must be a non-empty list or string")
        out = [str(x).strip() for x in p]
        out = [x for x in out if x]
        if not out:
            raise ValueError("prompts list is empty after trimming")
        return out
    if "prompt" in task:
        s = str(task["prompt"]).strip()
        if not s:
            raise ValueError("prompt must be non-empty")
        return [s]
    raise ValueError("Missing prompt or prompts")


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
            # Prefer local filesystem output if present.
            rel = osp.join(ref.get("subfolder", ""), ref["filename"]) if ref.get("subfolder") else ref["filename"]
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
    """
    Fetch an output image via ComfyUI /view and store it under LOCAL_OUTPUT_DIR.
    This avoids relying on Comfy's on-disk output layout.
    """
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
    full_positive: str,
    server_address: str,
    *,
    negative_text: str | None = None,
) -> str:
    w = deepcopy(api_workflow)
    pos = w.get(POSITIVE_NODE_ID)
    if not isinstance(pos, dict) or pos.get("class_type") != "CLIPTextEncode":
        raise RuntimeError(
            f"Workflow missing CLIPTextEncode positive node {POSITIVE_NODE_ID}"
        )
    pos.setdefault("inputs", {})["text"] = full_positive

    # Avoid Comfy fully caching repeated runs (cached-success can yield empty `outputs`),
    # by ensuring at least one meaningful input changes each request.
    # Prefer workflow node "19" (KSampler) when present; otherwise set seed on any KSampler node(s).
    seed = secrets.randbelow(2**63)
    ks = w.get("19")
    if isinstance(ks, dict) and ks.get("class_type") == "KSampler":
        ks.setdefault("inputs", {})["seed"] = int(seed)
    else:
        for _nid, node in w.items():
            if isinstance(node, dict) and node.get("class_type") == "KSampler":
                node.setdefault("inputs", {})["seed"] = int(seed)

    if negative_text is not None:
        neg = w.get(NEGATIVE_NODE_ID)
        if isinstance(neg, dict) and neg.get("class_type") == "CLIPTextEncode":
            neg.setdefault("inputs", {})["text"] = negative_text

    return task_queue(w, server_address)


def run_anime_gen_job(
    task: dict,
    *,
    workflows: dict,
    server_address: str,
) -> dict[str, Any]:
    out: dict[str, Any] = {"results": []}
    try:
        user_prompts = normalize_user_prompts(task)
        style_prefix = task.get("style_prefix")
        if style_prefix is not None:
            style_prefix = str(style_prefix).strip() or None

        neg_override = task.get("negative_prompt")
        if neg_override is not None:
            neg_override = str(neg_override).strip() or None

        skip_default_style_prefix = _coerce_task_bool(
            task.get("skip_default_style_prefix"), default=False
        )

        api = workflows.get(WORKFLOW_STEM)
        if not api:
            raise RuntimeError(
                f"Workflow {WORKFLOW_STEM} not loaded; add workflows/{WORKFLOW_STEM}.json"
            )

        for p_idx, user_p in enumerate(user_prompts):
            if skip_default_style_prefix:
                full = (user_p or "").strip()
            else:
                full = build_positive_prompt(user_p, style_prefix)
            pid: str | None = None
            try:
                pid = run_one_generation(
                    api,
                    full,
                    server_address,
                    negative_text=neg_override,
                )
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
                if _should_upload_to_s3():
                    upload_name = str(uuid.uuid4())
                    url = upload_to_s3(local_file, upload_name)
                    out["results"].append(
                        {
                            "prompt_index": p_idx,
                            "user_prompt": user_p,
                            "full_prompt": full,
                            "url": url,
                        }
                    )
                else:
                    out["results"].append(
                        {
                            "prompt_index": p_idx,
                            "user_prompt": user_p,
                            "full_prompt": full,
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
