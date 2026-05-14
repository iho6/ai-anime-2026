"""
CLI: load 1–3 images, run Qwen Image Edit workflow on a local ComfyUI server (default :8188).

Requires ComfyUI with the workflow JSON assets and models referenced by that workflow.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
import uuid
from pathlib import Path
from typing import Literal, Sequence

# Repo root must precede utils imports when running as a script.
_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from utils.comfyui_utils import (
    ComfyPhaseTracker,
    ComfyPromptError,
    queue_prompt,
    upload_image,
    view_image_bytes,
    wait_for_history_entry,
)
from utils.cli_exceptions import format_exception_chain_for_log, print_cli_error
from utils.comfyui_logging import ComfyJobContext, build_comfy_logger
from utils.image_utils import expand_sources_to_three_rgb_images, pil_to_png_bytes

DEFAULT_COMFY_URL = "http://127.0.0.1:8188"
DEFAULT_OUTPUT_DIR = Path("output") / "img-edit"
WORKFLOW_JSON = Path(__file__).parent / "image_qwen_image_edit_2509.json"
NODE_PROMPT = "435"
NODE_LOAD = ("78", "79", "80")
NODE_SAVE = "60"
NODE_SCALE = {"image1": "433:117", "image2": "433:118", "image3": "433:119"}
NODE_VAE_ENCODE = "433:88"
NODE_KSAMPLER = "433:3"
NODE_EMPTY_16_9_LATENT = "433:200"
LatentSource = Literal["image1", "image2", "image3", "empty_16_9"]


def run_img_edit(
    image_sources: Sequence[str],
    prompt: str,
    output_dir: Path,
    comfy_url: str = DEFAULT_COMFY_URL,
    *,
    workflow_path: Path = WORKFLOW_JSON,
    poll_interval_sec: float = 0.5,
    timeout_sec: float = 600.0,
    latent_source: LatentSource = "image1",
) -> list[Path]:
    """
    Load images, upload to Comfy, run the workflow, download SaveImage outputs to ``output_dir``.
    """
    if not (1 <= len(image_sources) <= 3):
        raise ValueError("image_sources must have 1 to 3 items")
    if not prompt.strip():
        raise ValueError("prompt must be non-empty")
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    base = comfy_url.rstrip("/")
    logger = build_comfy_logger()
    ctx = ComfyJobContext(
        job_id=uuid.uuid4().hex,
        service="img_edit",
        workflow=str(workflow_path),
        comfy_url=base,
    )
    logger.event(event="job.start", level="debug", ctx=ctx, data={"image_count": len(image_sources), "output_dir": str(out)})
    three = expand_sources_to_three_rgb_images(list(image_sources))
    logger.event(event="job.inputs.validated", level="debug", ctx=ctx, data={"expanded_images": len(three)})
    phase = ComfyPhaseTracker(logger=logger, ctx=ctx)
    names: list[str] = []
    uid = ctx.job_id
    for i, im in enumerate(three):
        fn = f"img_edit_{uid}_{i}.png"
        names.append(
            upload_image(base, pil_to_png_bytes(im), fn, timeout=120, logger=logger, ctx=ctx)
        )

    workflow: dict = copy.deepcopy(
        json.loads(workflow_path.read_text(encoding="utf-8"))
    )
    workflow[NODE_PROMPT]["inputs"]["value"] = prompt
    for node_id, name in zip(NODE_LOAD, names, strict=True):
        workflow[node_id]["inputs"]["image"] = name

    # Select which input determines the latent canvas aspect/size.
    if latent_source == "empty_16_9":
        workflow[NODE_KSAMPLER]["inputs"]["latent_image"] = [NODE_EMPTY_16_9_LATENT, 0]
    else:
        scale_node = NODE_SCALE.get(latent_source)
        if scale_node is None:
            raise ValueError(f"Unsupported latent_source: {latent_source!r}")
        workflow[NODE_VAE_ENCODE]["inputs"]["pixels"] = [scale_node, 0]
        workflow[NODE_KSAMPLER]["inputs"]["latent_image"] = [NODE_VAE_ENCODE, 0]

    logger.event(event="workflow.prepared", level="debug", ctx=ctx, data={"nodes": len(workflow)})
    client_id = ctx.job_id
    resp = queue_prompt(
        base,
        workflow,
        client_id,
        timeout=1200,
        logger=logger,
        ctx=ctx,
        phase_tracker=phase,
    )
    prompt_id = resp["prompt_id"]
    ctx.prompt_id = prompt_id
    entry = wait_for_history_entry(
        base,
        prompt_id,
        timeout_sec=timeout_sec,
        poll_interval_sec=poll_interval_sec,
        logger=logger,
        ctx=ctx,
        phase_tracker=phase,
    )

    outputs = entry.get("outputs") or {}
    save_out = outputs.get(NODE_SAVE) or {}
    images_meta = save_out.get("images") or []
    if not images_meta:
        raise RuntimeError(
            f"No images in history outputs for SaveImage node {NODE_SAVE}: {entry!r}"
        )

    written: list[Path] = []
    for item in images_meta:
        filename = item["filename"]
        subfolder = item.get("subfolder") or ""
        folder_type = item.get("type") or "output"
        data = view_image_bytes(
            base, filename, subfolder, folder_type, timeout=120, logger=logger, ctx=ctx
        )
        dest = out / filename
        if dest.exists():
            dest = out / f"{dest.stem}_{uuid.uuid4().hex[:8]}{dest.suffix}"
        dest.write_bytes(data)
        written.append(dest)
    logger.event(event="job.outputs.saved", level="debug", ctx=ctx, data={"count": len(written)})
    logger.event(event="job.done", level="debug", ctx=ctx, data={"count": len(written)})
    return written


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Run Qwen Image Edit workflow via local ComfyUI (default port 8188)."
    )
    p.add_argument(
        "--images",
        nargs="+",
        required=True,
        metavar="PATH_OR_URL",
        help="1–3 reference images (local paths or http(s) URLs).",
    )
    p.add_argument("--prompt", required=True, help="Edit instruction (non-empty).")
    p.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Directory for downloaded PNGs (default: {DEFAULT_OUTPUT_DIR}).",
    )
    p.add_argument(
        "--comfy-url",
        default=DEFAULT_COMFY_URL,
        help=f"ComfyUI base URL (default: {DEFAULT_COMFY_URL}).",
    )
    return p.parse_args(argv)


def handler(args: argparse.Namespace) -> int:
    if not (1 <= len(args.images) <= 3):
        print(
            "error: --images requires 1 to 3 items",
            file=sys.stderr,
        )
        return 1
    if not str(args.prompt).strip():
        print("error: --prompt must be non-empty", file=sys.stderr)
        return 1
    try:
        paths = run_img_edit(
            args.images,
            args.prompt,
            Path(args.output_dir),
            comfy_url=str(args.comfy_url),
        )
    except (ComfyPromptError, OSError, TimeoutError, ValueError, RuntimeError) as e:
        logger = build_comfy_logger()
        ctx = ComfyJobContext(
            job_id=uuid.uuid4().hex,
            service="img_edit",
            workflow=str(WORKFLOW_JSON),
            comfy_url=str(args.comfy_url).rstrip("/"),
        )
        logger.event(
            event="job.error",
            level="error",
            ctx=ctx,
            data={
                "error": str(e),
                "error_type": type(e).__name__,
                "traceback": format_exception_chain_for_log(e),
            },
        )
        print_cli_error(e)
        return 1
    for p in paths:
        print("saved", p.resolve())
    return 0


def main() -> None:
    sys.exit(handler(parse_args()))


if __name__ == "__main__":
    main()
