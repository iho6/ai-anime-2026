"""
Anime character segmentation — local --test-mode (SkyTNT/anime-segmentation).

No ComfyUI. Loads isnet_is from models/anime_seg/isnetis.ckpt by default.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d - %(levelname)s - %(message)s",
)
logger = logging.getLogger("anime_seg_ai_service")

_SERVICE_DIR = Path(__file__).resolve().parent


def _parse_image_urls(raw: str) -> list[str]:
    text = (raw or "").strip()
    if not text:
        raise ValueError("--image-url is empty")
    if text.startswith("["):
        data = json.loads(text)
        if isinstance(data, list):
            refs = [str(x).strip() for x in data if str(x).strip()]
            if refs:
                return refs
        raise ValueError("JSON array for --image-url must contain paths")
    return [text]


def run_segment(
    image_path: str,
    *,
    anime_seg_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from services.anime_seg_ai_service.inference_core import (
        options_from_dict,
        segment_image_to_rgba,
    )

    opts = options_from_dict(anime_seg_options)
    out = Path(tempfile.gettempdir()) / f"anime_seg_{uuid.uuid4().hex}.png"
    local = segment_image_to_rgba(image_path, out, **opts)
    return {"local_path": local, "url": f"file://{local}"}


def handler(job_input: dict[str, Any]) -> dict[str, Any]:
    task = job_input.get("input") or job_input
    if not isinstance(task, dict):
        return {"error": "Missing or invalid job input", "results": []}

    urls = []
    if task.get("image_urls"):
        urls = [str(u).strip() for u in task["image_urls"] if str(u).strip()]
    elif task.get("image_url"):
        urls = [str(task["image_url"]).strip()]
    if not urls:
        return {"error": "image_url or image_urls required", "results": []}

    raw_opts = task.get("anime_seg") or task.get("animeSeg")
    opts = dict(raw_opts) if isinstance(raw_opts, dict) else None

    results: list[dict[str, Any]] = []
    for i, path in enumerate(urls):
        try:
            item = run_segment(path, anime_seg_options=opts)
            results.append(
                {
                    "image_index": i,
                    "source_url": path,
                    "url": item["url"],
                    "local_path": item["local_path"],
                }
            )
        except Exception as e:
            logger.exception("anime_seg failed for %s", path)
            return {"error": str(e), "results": results}
    return {"results": results}


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Anime segmentation AI service")
    p.add_argument("--test-mode", action="store_true")
    p.add_argument(
        "--image-url",
        type=str,
        default=None,
        help="Local image path or JSON array of paths",
    )
    p.add_argument(
        "--anime-seg-json",
        type=str,
        default=None,
        help="JSON object of segmentation options",
    )
    return p.parse_args()


def _run_test_mode(args: argparse.Namespace) -> None:
    if not args.image_url:
        print("ERROR: --image-url required in test mode", file=sys.stderr)
        sys.exit(1)
    try:
        urls = _parse_image_urls(args.image_url)
    except (ValueError, json.JSONDecodeError) as e:
        print("ERROR: invalid --image-url:", e, file=sys.stderr)
        sys.exit(1)

    opts: dict[str, Any] | None = None
    if args.anime_seg_json:
        try:
            raw = json.loads(args.anime_seg_json)
        except json.JSONDecodeError as e:
            print("ERROR: invalid --anime-seg-json:", e, file=sys.stderr)
            sys.exit(1)
        if not isinstance(raw, dict):
            print("ERROR: --anime-seg-json must be a JSON object", file=sys.stderr)
            sys.exit(1)
        opts = raw

    out_results: list[dict[str, Any]] = []
    for path in urls:
        out_results.append(run_segment(path, anime_seg_options=opts))
    print(json.dumps({"results": out_results}, indent=2))


def main() -> None:
    args = _parse_args()
    if args.test_mode:
        _run_test_mode(args)
    else:
        print("RunPod mode not implemented; use --test-mode", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
