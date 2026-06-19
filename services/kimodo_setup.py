"""
Kimodo editable install helpers (MotionCorrection C extension).

Requires system packages: cmake, build-essential, python{X.Y}-dev matching the
active interpreter. CMake must build against the venv Python, not system python.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable

_REPO_ROOT = Path(__file__).resolve().parents[1]
_KIMODO_DIR = _REPO_ROOT / "kimodo"
_BUILD_CMAKE_PATH = _KIMODO_DIR / "build_cmake.py"


def _load_build_cmake():
    spec = importlib.util.spec_from_file_location("kimodo_build_cmake", _BUILD_CMAKE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"kimodo build helper not found: {_BUILD_CMAKE_PATH}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_build_cmake = _load_build_cmake()

kimodo_build_packages = _build_cmake.kimodo_build_packages
python_dev_headers_ready = _build_cmake.python_dev_headers_ready
require_python_dev_headers = _build_cmake.require_python_dev_headers
python_cmake_args = _build_cmake.python_cmake_args


def kimodo_cmake_args() -> list[str]:
    """Backward-compatible alias for python_cmake_args()."""
    return python_cmake_args()


def kimodo_importable() -> bool:
    try:
        import motion_correction  # noqa: F401
        import kimodo  # noqa: F401
        return True
    except ImportError:
        return False


def _kimodo_pip_install_env() -> dict[str, str]:
    env = os.environ.copy()
    # Belt-and-suspenders: setup.py also reads python_cmake_args() directly.
    env["KIMODO_CMAKE_ARGS"] = " ".join(python_cmake_args())
    return env


def _kimodo_pip_install_cmd(kimodo_dir: Path) -> list[str]:
    return [sys.executable, "-m", "pip", "install", "-e", str(kimodo_dir)]


def _build_deps_apt_cmd() -> list[str]:
    return ["apt-get", "install", "-y", *kimodo_build_packages()]


def _apt_runner() -> list[str]:
    """Return prefix for apt-get (empty when root, else sudo if available)."""
    if os.name != "posix" or not sys.platform.startswith("linux"):
        return []
    if os.geteuid() == 0:
        return []
    if shutil.which("sudo"):
        return ["sudo"]
    return []


def _run_apt_build_deps(*, log_cb: Callable[[str], None] | None = None) -> None:
    if not sys.platform.startswith("linux") or not shutil.which("apt-get"):
        return
    if os.geteuid() != 0 and not shutil.which("sudo"):
        return
    runner = _apt_runner()
    cmd = [*runner, *_build_deps_apt_cmd()]
    if log_cb:
        log_cb("$ " + " ".join(cmd))
    proc = subprocess.run(
        cmd,
        cwd=str(_REPO_ROOT),
        capture_output=not log_cb,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        out = (proc.stderr or proc.stdout or "apt-get install failed").strip()
        packages = " ".join(kimodo_build_packages())
        raise RuntimeError(
            f"Failed to install kimodo build dependencies: {out}\n"
            f"Install manually: sudo apt-get install -y {packages}"
        )
    if log_cb and proc.stdout:
        for line in proc.stdout.splitlines():
            log_cb(line)


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
            _build_deps_apt_cmd(),
            cwd=_REPO_ROOT,
            log_cb=log_cb,
        )
    except RuntimeError as exc:
        raise RuntimeError(
            "Failed to install kimodo build dependencies. "
            f"Install manually: sudo apt-get install -y {' '.join(packages)}"
        ) from exc
    require_python_dev_headers()


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


def _kimodo_install_failure_message(err: str) -> str:
    packages = " ".join(kimodo_build_packages())
    return (
        f"{err}\n"
        f"Kimodo builds MotionCorrection against {sys.executable} (not system python). "
        f"Ensure build deps are installed: sudo apt-get install -y {packages}"
    )


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

    ensure_kimodo_build_deps(run_command=run_command, log_cb=log_cb)
    kimodo_dir = _ensure_kimodo_repo(run_command=run_command, log_cb=log_cb)
    if log_cb:
        log_cb("Installing kimodo (editable, with MotionCorrection C extension)…")
    run_command(
        _kimodo_pip_install_cmd(kimodo_dir),
        cwd=_REPO_ROOT,
        log_cb=log_cb,
        env=_kimodo_pip_install_env(),
    )
    if not kimodo_importable():
        packages = " ".join(kimodo_build_packages())
        raise RuntimeError(
            "kimodo install finished but motion_correction is not importable. "
            f"Ensure build deps are installed: sudo apt-get install -y {packages}"
        )


def pip_install_kimodo_editable() -> None:
    """Standalone pip install for scripts/manual use (attempts apt build deps on Linux)."""
    if kimodo_importable():
        return

    kimodo_dir = _KIMODO_DIR
    if not kimodo_dir.is_dir():
        raise RuntimeError(f"kimodo directory not found: {kimodo_dir}")

    if not python_dev_headers_ready():
        _run_apt_build_deps()
    require_python_dev_headers()

    proc = subprocess.run(
        _kimodo_pip_install_cmd(kimodo_dir),
        cwd=str(_REPO_ROOT),
        env=_kimodo_pip_install_env(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "pip install failed").strip()
        raise RuntimeError(_kimodo_install_failure_message(err))
    if not kimodo_importable():
        packages = " ".join(kimodo_build_packages())
        raise RuntimeError(
            "kimodo install finished but motion_correction is not importable. "
            f"Ensure build deps are installed: sudo apt-get install -y {packages}"
        )
