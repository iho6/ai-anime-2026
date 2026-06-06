#!/usr/bin/env python3
"""Run multi-angle workflow locally for one image over selected camera angles.

Uses workflows/comfyui-workflow-multiple-angles_api.json. Writes into angle_library/
per image (see README).

Usage:
    python -m services.multi_angle_ai_service.run_batch_angles image.png
    python -m services.multi_angle_ai_service.run_batch_angles image.png --numb-angles 8 --skip-cached
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import random
import shutil
import sys

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from services.constant import LOCAL_INPUT_DIR, TIMEOUT
from services.multi_angle_ai_service import angle_library
from services.multi_angle_ai_service.serverless import (
    append_default_multi_angle_background_instruction,
)
from services.utils import (
    fetch_comfy_history,
    task_queue,
    waiting_for_results,
    wait_for_service_ready,
)


def _load_workflow_and_angles(service_dir: str):
    workflows_dir = os.path.join(service_dir, "workflows")
    api_path = os.path.join(
        workflows_dir, "comfyui-workflow-multiple-angles_api.json"
    )
    angles_path = os.path.join(service_dir, "camera_angles.json")

    if not os.path.isfile(api_path):
        print(f"Missing API workflow: {api_path}", file=sys.stderr)
        sys.exit(1)
    with open(api_path, "r", encoding="utf-8") as f:
        workflow = json.load(f)

    if not os.path.isfile(angles_path):
        print(f"Missing camera angles: {angles_path}", file=sys.stderr)
        sys.exit(1)
    with open(angles_path, "r", encoding="utf-8") as f:
        angles = json.load(f)

    return workflow, angles


def _find_image_and_prompt_nodes(
    workflow: dict,
) -> tuple[str | None, str | None, str | None]:
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
        for nid, txt in prompt_candidates:
            title = ((workflow[nid].get("_meta") or {}).get("title") or "")
            if "positive" in title.lower():
                prompt_node = nid
                break
        if prompt_node is None:
            nonempty = [(nid, txt) for nid, txt in prompt_candidates if txt.strip()]
            prompt_node = nonempty[0][0] if nonempty else prompt_candidates[0][0]

    return load_image_node, prompt_node, sampler_node


def _set_workflow_inputs(
    workflow: dict, image_basename: str, prompt_text: str
) -> dict:
    w = copy.deepcopy(workflow)
    load_nid, prompt_nid, sampler_nid = _find_image_and_prompt_nodes(w)
    if load_nid:
        w[load_nid]["inputs"]["image"] = image_basename
    if prompt_nid:
        if "value" in w[prompt_nid]["inputs"]:
            w[prompt_nid]["inputs"]["value"] = prompt_text
        elif "prompt" in w[prompt_nid]["inputs"]:
            w[prompt_nid]["inputs"]["prompt"] = prompt_text
    if sampler_nid and "seed" in w[sampler_nid].get("inputs", {}):
        w[sampler_nid]["inputs"]["seed"] = random.randint(0, 2**53)
    return w


def _get_output_filename_from_history(
    server_address: str, prompt_id: str
) -> str | None:
    data = fetch_comfy_history(server_address, prompt_id)
    if not data or prompt_id not in data:
        return None
    outputs = data[prompt_id].get("outputs") or {}
    for _nid, out in outputs.items():
        images = out.get("images")
        if images and len(images) > 0:
            return images[0].get("filename")
    return None


def _resolve_prompt_for_angle(angle: dict, override: str | None) -> str:
    if override is not None and str(override).strip():
        return str(override).strip()
    return angle["prompt_text"]


def main():
    parser = argparse.ArgumentParser(
        description="Batch multi-angle generation (local ComfyUI only)"
    )
    parser.add_argument("image", help="Path to input image")
    parser.add_argument(
        "--numb-angles",
        type=int,
        default=None,
        metavar="N",
        help="Random subset size (default: all angles in camera_angles.json)",
    )
    parser.add_argument(
        "--server", default="127.0.0.1:8188", help="ComfyUI address"
    )
    parser.add_argument(
        "--comfy-output-dir",
        default="comfyui/output",
        help="ComfyUI output directory",
    )
    parser.add_argument(
        "--skip-cached",
        action="store_true",
        help="Skip angles that already have at least one image in the library",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Run Comfy even if skip-cached would apply",
    )
    parser.add_argument(
        "--library-key",
        default=None,
        help="Optional stable folder name under angle_library (overrides basename_hash)",
    )
    parser.add_argument(
        "--prompt-text",
        default=None,
        help="Override prompt for every angle in this batch (same as serverless prompt_text)",
    )
    args = parser.parse_args()

    service_dir = os.path.dirname(os.path.abspath(__file__))
    workflow, angles = _load_workflow_and_angles(service_dir)

    if args.numb_angles is not None:
        if args.numb_angles <= 0 or args.numb_angles > len(angles):
            print(f"--numb-angles must be between 1 and {len(angles)}", file=sys.stderr)
            sys.exit(1)
        selected = random.sample(angles, args.numb_angles)
    else:
        selected = angles

    image_path = os.path.abspath(args.image)
    if not os.path.isfile(image_path):
        print(f"Image not found: {image_path}", file=sys.stderr)
        sys.exit(1)

    if not wait_for_service_ready(args.server):
        print(
            "ComfyUI not reachable. Start ComfyUI (GPU) and pass --server if needed.",
            file=sys.stderr,
        )
        sys.exit(2)

    os.makedirs(LOCAL_INPUT_DIR, exist_ok=True)
    image_basename = os.path.basename(image_path)
    local_input = os.path.join(LOCAL_INPUT_DIR, image_basename)
    if local_input != image_path:
        shutil.copy2(image_path, local_input)

    comfy_output = os.path.abspath(args.comfy_output_dir)
    lib_dir = angle_library.image_library_dir(
        service_dir,
        source_path=image_path,
        library_key=args.library_key,
    )
    angle_library.ensure_starting_image(lib_dir, image_path)
    print(f"Angle library folder: {lib_dir}")
    print(f"Running {len(selected)} angle(s), server={args.server}")

    for i, angle in enumerate(selected):
        angle_id = int(angle.get("id", i))
        angle_dir = angle_library.angle_subdir(lib_dir, angle_id)
        if args.skip_cached and not args.force:
            if angle_library.angle_has_cached_output(angle_dir):
                print(
                    f"  [{i + 1}/{len(selected)}] angle {angle_id} skipped (cached)"
                )
                continue

        prompt_text = append_default_multi_angle_background_instruction(
            _resolve_prompt_for_angle(angle, args.prompt_text)
        )
        w = _set_workflow_inputs(workflow, image_basename, prompt_text)
        try:
            prompt_id = task_queue(w, args.server)
            waiting_for_results(prompt_id, args.server, timeout_seconds=TIMEOUT)
            filename = _get_output_filename_from_history(args.server, prompt_id)
            if filename:
                src = os.path.join(comfy_output, filename)
                if os.path.isfile(src):
                    angle_library.save_generation_to_library(
                        service_dir,
                        source_path=image_path,
                        angle_id=angle_id,
                        comfy_output_file=src,
                        library_key=args.library_key,
                    )
                    print(f"  [{i + 1}/{len(selected)}] angle {angle_id} -> saved")
                else:
                    print(
                        f"  [{i + 1}/{len(selected)}] angle {angle_id} output missing: {src}",
                        file=sys.stderr,
                    )
            else:
                print(
                    f"  [{i + 1}/{len(selected)}] angle {angle_id} no image in history",
                    file=sys.stderr,
                )
        except Exception as e:
            print(
                f"  [{i + 1}/{len(selected)}] angle {angle_id} failed: {e}",
                file=sys.stderr,
            )

    print("Done.")


if __name__ == "__main__":
    main()
