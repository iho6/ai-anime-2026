#!/usr/bin/env python3
"""Download Hugging Face model repos to local disk (no vLLM required).

This is intended for provisioning large model weights (e.g. Qwen3-VL) without
coupling downloads to any CUDA/vLLM runtime.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download Hugging Face model repositories using snapshot_download.",
    )
    parser.add_argument(
        "--repo-id",
        action="append",
        default=[],
        help='HF repo id to download (repeatable). Example: "Qwen/Qwen3-VL-4B-Instruct".',
    )
    parser.add_argument(
        "--local-dir",
        type=Path,
        default=Path("models/hf"),
        help='Destination root (default: "models/hf"). A subfolder per repo is created.',
    )
    parser.add_argument(
        "--revision",
        type=str,
        default=None,
        help="Optional git revision/branch/tag.",
    )
    parser.add_argument(
        "--hf-token",
        type=str,
        default=None,
        help="Hugging Face token (or set HF_TOKEN env var).",
    )
    args = parser.parse_args(argv)
    if not args.repo_id:
        args.repo_id = ["Qwen/Qwen3-VL-4B-Instruct"]
    return args


def safe_repo_dirname(repo_id: str) -> str:
    return repo_id.replace("/", "__").replace(":", "_")


def main() -> None:
    args = parse_args()

    try:
        from huggingface_hub import snapshot_download
    except Exception as exc:  # pragma: no cover
        raise SystemExit(
            "huggingface_hub is required. Install via: pip install huggingface_hub"
        ) from exc

    token = args.hf_token or os.environ.get("HF_TOKEN")
    for repo_id in args.repo_id:
        dest = Path(args.local_dir) / safe_repo_dirname(str(repo_id))
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading: {repo_id}")
        print(f"  -> {dest}")
        path = snapshot_download(
            repo_id=str(repo_id),
            local_dir=str(dest),
            local_dir_use_symlinks=False,
            revision=args.revision,
            token=token,
        )
        print(f"OK: {path}")


if __name__ == "__main__":
    main()

