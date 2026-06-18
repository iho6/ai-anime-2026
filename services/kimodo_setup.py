"""
Kimodo editable install helpers (MotionCorrection C extension).

Requires system packages: cmake, build-essential, python{X.Y}-dev matching the
active interpreter. CMake must build against the venv Python, not system python.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from typing import Callable

_REPO_ROOT = Path(__file__).resolve().parents[1]
_KIMODO_DIR = _REPO_ROOT / "kimodo"


def kimodo_importable() -> bool:
    try:
        import motion_correction  # noqa: F401
        import kimodo  # noqa: F401
        return True
    except ImportError:
        return False


def kimodo_build_packages() -> list[str]:
    py_tag = f"{sys.version_info.major}.{sys.version_info.minor}"
    return ["cmake", "build-essential", f"python{py_tag}-dev"]


def ensure_kimodo_build_deps(
    *,
    run_command: Callable[..., None],
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Install apt packages needed to compile motion_correction."""
    packages = kimodo_build_packages()
    if log_cb:
        log_cb(f"Ensuring kimodo build deps: {', '.join(packages)}")
    try:
        run_command(
            ["apt-get", "install", "-y", *packages],
            cwd=_REPO_ROOT,
            log_cb=log_cb,
        )
    except RuntimeError as exc:
        raise RuntimeError(
            "Failed to install kimodo build dependencies. "
            f"Install manually: sudo apt-get install -y {' '.join(packages)}"
        ) from exc


def _ensure_kimodo_repo(
    *,
    run_command: Callable[..., None],
    log_cb: Callable[[str], None] | None = None,
) -> Path:
    if (kimodo_dir := _KIMODO_DIR).is_dir() and (
        (kimodo_dir / "setup.py").is_file() or (kimodo_dir / "pyproject.toml").is_file()
    ):
        return kimodo_dir
    if log_cb:
        log_cb("Cloning nv-tlabs/kimodo…")
    run_command(
        ["git", "clone", "https://github.com/nv-tlabs/kimodo.git", str(kimodo_dir)],
        cwd=_REPO_ROOT,
        log_cb=log_cb,
    )
    return kimodo_dir


def ensure_kimodo_installed(
    *,
    run_command: Callable[..., None],
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Editable-install kimodo with MotionCorrection when imports are missing."""
    if kimodo_importable():
        if log_cb:
            log_cb("kimodo + motion_correction already importable")
        return

    kimodo_dir = _ensure_kimodo_repo(run_command=run_command, log_cb=log_cb)
    if log_cb:
        log_cb("Installing kimodo (editable, with MotionCorrection C extension)…")
    run_command(
        [sys.executable, "-m", "pip", "install", "-e", str(kimodo_dir)],
        cwd=_REPO_ROOT,
        log_cb=log_cb,
    )
    if not kimodo_importable():
        packages = " ".join(kimodo_build_packages())
        raise RuntimeError(
            "kimodo install finished but motion_correction is not importable. "
            f"Ensure build deps are installed: sudo apt-get install -y {packages}"
        )


def pip_install_kimodo_editable() -> None:
    """Standalone pip install for scripts/manual use (no apt, no clone)."""
    kimodo_dir = _KIMODO_DIR
    if not kimodo_dir.is_dir():
        raise RuntimeError(f"kimodo directory not found: {kimodo_dir}")
    proc = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-e", str(kimodo_dir)],
        cwd=str(_REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "pip install failed").strip()
        packages = " ".join(kimodo_build_packages())
        raise RuntimeError(
            f"kimodo editable install failed: {err}\n"
            f"Try: sudo apt-get install -y {packages}"
        )
