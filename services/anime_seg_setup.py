"""
Anime segmentation dependency helpers (pytorch-lightning, timm).

Vendored SkyTNT/anime-segmentation loads checkpoints via train.AnimeSegmentation,
which imports pytorch_lightning at module load.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Callable

_REPO_ROOT = Path(__file__).resolve().parents[1]

_ANIME_SEG_PIP_PACKAGES = ("pytorch-lightning>=2.0", "timm>=0.9")


def anime_seg_importable() -> bool:
    try:
        import pytorch_lightning  # noqa: F401
        import timm  # noqa: F401
        return True
    except ImportError:
        return False


def _pip_install_anime_seg_deps(*, log_cb: Callable[[str], None] | None) -> None:
    cmd = [sys.executable, "-m", "pip", "install", *_ANIME_SEG_PIP_PACKAGES]
    if log_cb:
        log_cb("$ " + " ".join(cmd))
    proc = subprocess.run(
        cmd,
        cwd=str(_REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if log_cb and proc.stdout:
        for line in proc.stdout.splitlines():
            if line.strip():
                log_cb(line)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "pip install failed").strip()
        raise RuntimeError(
            "Anime seg package install failed: "
            f"{err}\nTry manually: pip install {' '.join(_ANIME_SEG_PIP_PACKAGES)}"
        )


def ensure_anime_seg_deps(*, log_cb: Callable[[str], None] | None = None) -> None:
    """Install pytorch-lightning + timm when anime segmentation imports are missing."""
    if anime_seg_importable():
        if log_cb:
            log_cb("Anime seg packages OK")
        return
    if log_cb:
        log_cb("Ensuring anime seg packages…")
    _pip_install_anime_seg_deps(log_cb=log_cb)
    if not anime_seg_importable():
        raise RuntimeError(
            "Anime seg packages not fully installed after pip install. "
            f"Try: pip install {' '.join(_ANIME_SEG_PIP_PACKAGES)}"
        )
    if log_cb:
        log_cb("Anime seg packages installed")
