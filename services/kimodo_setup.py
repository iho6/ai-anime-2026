"""
Kimodo editable install helpers (MotionCorrection C extension).

Requires system packages: cmake, build-essential, python{X.Y}-dev matching the
active interpreter. CMake must build against the venv Python, not system python.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

from services.kimodo_build_cmake import (
    kimodo_build_packages,
    python_cmake_args,
    python_dev_headers_ready,
    require_python_dev_headers,
)

_REPO_ROOT = Path(__file__).resolve().parents[1]
_KIMODO_DIR = _REPO_ROOT / "kimodo"
_PATCHES_DIR = _REPO_ROOT / "patches" / "kimodo"
_KIMODO_REQUIREMENTS = _PATCHES_DIR / "kimodo-requirements.txt"
_MOTION_CORRECTION_PKG_DIR = (
    _KIMODO_DIR / "MotionCorrection" / "python" / "motion_correction"
)

_KIMODO_OVERLAY_FILES = (
    "build_cmake.py",
    "setup.py",
    "MANIFEST.in",
    "MotionCorrection/setup.py",
    "kimodo/scripts/run_text_encoder_server.py",
    "kimodo/assets/__init__.py",
)

_KIMODO_OVERLAY_REMOVALS = (
    "kimodo/assets.py",
)


def kimodo_cmake_args() -> list[str]:
    """Backward-compatible alias for python_cmake_args()."""
    return python_cmake_args()


def apply_kimodo_patches(
    kimodo_dir: Path,
    *,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Copy parent-repo overlays into kimodo submodule (CMake + runtime fixes)."""
    for rel in _KIMODO_OVERLAY_FILES:
        src = _PATCHES_DIR / rel
        dst = kimodo_dir / rel
        if not src.is_file():
            raise RuntimeError(f"Missing kimodo overlay: {src}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if log_cb:
            log_cb(f"Applied kimodo overlay: {rel}")
    for rel in _KIMODO_OVERLAY_REMOVALS:
        dst = kimodo_dir / rel
        if dst.is_file():
            dst.unlink()
            if log_cb:
                log_cb(f"Removed conflicting kimodo file: {rel}")


def apply_kimodo_cmake_patches(
    kimodo_dir: Path,
    *,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Backward-compatible alias for apply_kimodo_patches."""
    apply_kimodo_patches(kimodo_dir, log_cb=log_cb)


def motion_correction_extension_files(kimodo_dir: Path | None = None) -> list[Path]:
    """Built extension modules under the kimodo tree, if any."""
    pkg_dir = (
        (kimodo_dir or _KIMODO_DIR)
        / "MotionCorrection"
        / "python"
        / "motion_correction"
    )
    if not pkg_dir.is_dir():
        return []
    return sorted(pkg_dir.glob("_motion_correction*.so"))


def _subprocess_import_status() -> tuple[bool, list[str]]:
    """Import kimodo + motion_correction in a fresh interpreter from a neutral cwd.

    Editable installs register packages via .pth files that site.py only reads at
    interpreter startup, so an in-process import would miss a just-installed package.
    A neutral cwd also avoids the repo's kimodo/ dir resolving as a namespace package.
    """
    script = (
        "import importlib, sys\n"
        "ok = True\n"
        "for name in ('kimodo', 'motion_correction'):\n"
        "    try:\n"
        "        m = importlib.import_module(name)\n"
        "        if getattr(m, '__file__', None) is None and not getattr(m, '__path__', None):\n"
        "            raise ImportError('namespace-only import (package not found)')\n"
        "        print(f'{name}: import OK')\n"
        "    except Exception as exc:\n"
        "        ok = False\n"
        "        print(f'{name}: import failed ({type(exc).__name__}: {exc})')\n"
        "sys.exit(0 if ok else 1)\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script],
        cwd=tempfile.gettempdir(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if proc.returncode != 0 and proc.stderr and not lines:
        lines.append(proc.stderr.strip())
    return proc.returncode == 0, lines


def _kimodo_import_status(kimodo_dir: Path | None = None) -> tuple[bool, str]:
    """Try kimodo + motion_correction imports; report per-module errors and .so state."""
    ok, lines = _subprocess_import_status()

    so_files = motion_correction_extension_files(kimodo_dir)
    if so_files:
        lines.append("motion_correction extension: " + ", ".join(p.name for p in so_files))
    else:
        ok = False
        pkg = (
            (kimodo_dir or _KIMODO_DIR)
            / "MotionCorrection"
            / "python"
            / "motion_correction"
        )
        lines.append(
            f"motion_correction extension: missing (no _motion_correction*.so under {pkg})"
        )

    return ok, "\n".join(lines)


def kimodo_importable() -> bool:
    ok, _ = _kimodo_import_status()
    return ok


def _kimodo_pip_install_env() -> dict[str, str]:
    env = os.environ.copy()
    env["KIMODO_TARGET_PYTHON"] = sys.executable
    env["KIMODO_CMAKE_ARGS"] = " ".join(python_cmake_args())
    env["SKIP_MOTION_CORRECTION_IN_SETUP"] = "1"
    return env


def _kimodo_pip_install_cmd(kimodo_dir: Path) -> list[str]:
    return [
        sys.executable,
        "-m",
        "pip",
        "install",
        "-e",
        str(kimodo_dir),
        "--no-build-isolation",
        "--no-deps",
    ]


def _motion_correction_pip_install_cmd(kimodo_dir: Path) -> list[str]:
    return [
        sys.executable,
        "-m",
        "pip",
        "install",
        "-e",
        str(kimodo_dir / "MotionCorrection"),
        "--no-build-isolation",
        "--no-deps",
    ]


def _kimodo_requirements_install_cmd() -> list[str]:
    return [sys.executable, "-m", "pip", "install", "-r", str(_KIMODO_REQUIREMENTS)]


def _run_pip_install(
    cmd: list[str],
    *,
    run_command: Callable[..., None] | None,
    log_cb: Callable[[str], None] | None,
    env: dict[str, str],
) -> None:
    if run_command is not None:
        run_command(cmd, cwd=_REPO_ROOT, log_cb=log_cb, env=env)
        return
    proc = subprocess.run(
        cmd,
        cwd=str(_REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "pip install failed").strip()
        raise RuntimeError(_kimodo_install_failure_message(err))


def _run_kimodo_editable_install(
    kimodo_dir: Path,
    *,
    run_command: Callable[..., None] | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """Apply patches, editable-install kimodo + motion_correction, restore cu128 torch."""
    apply_kimodo_patches(kimodo_dir, log_cb=log_cb)
    env = _kimodo_pip_install_env()
    if log_cb:
        log_cb("Installing kimodo (editable, Python package only)…")
    _run_pip_install(
        _kimodo_pip_install_cmd(kimodo_dir),
        run_command=run_command,
        log_cb=log_cb,
        env=env,
    )
    if log_cb:
        log_cb("Installing motion_correction (editable C extension)…")
    _run_pip_install(
        _motion_correction_pip_install_cmd(kimodo_dir),
        run_command=run_command,
        log_cb=log_cb,
        env=env,
    )
    if log_cb:
        log_cb("Installing kimodo runtime dependencies…")
    _run_pip_install(
        _kimodo_requirements_install_cmd(),
        run_command=run_command,
        log_cb=log_cb,
        env=os.environ.copy(),
    )
    from services.pytorch_setup import ensure_pytorch_stack

    ensure_pytorch_stack(log_cb=log_cb)


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


def _run_git_clone(
    cmd: list[str],
    *,
    run_command: Callable[..., None] | None,
    log_cb: Callable[[str], None] | None,
) -> None:
    if run_command is not None:
        run_command(cmd, cwd=_REPO_ROOT, log_cb=log_cb)
        return
    proc = subprocess.run(
        cmd,
        cwd=str(_REPO_ROOT),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "git clone failed").strip()
        raise RuntimeError(f"Failed to clone kimodo: {err}")


def _ensure_kimodo_repo(
    *,
    run_command: Callable[..., None] | None = None,
    log_cb: Callable[[str], None] | None = None,
) -> Path:
    if (kimodo_dir := _KIMODO_DIR).is_dir() and (
        (kimodo_dir / "setup.py").is_file() or (kimodo_dir / "pyproject.toml").is_file()
    ):
        return kimodo_dir
    if log_cb:
        log_cb("Cloning nv-tlabs/kimodo…")
    _run_git_clone(
        ["git", "clone", "https://github.com/nv-tlabs/kimodo.git", str(kimodo_dir)],
        run_command=run_command,
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


def _kimodo_post_install_failure_message(kimodo_dir: Path) -> str:
    packages = " ".join(kimodo_build_packages())
    _, status = _kimodo_import_status(kimodo_dir)
    return (
        "kimodo install finished but motion_correction is not importable.\n"
        f"{status}\n"
        f"Build deps (if needed): sudo apt-get install -y {packages}"
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
    _run_kimodo_editable_install(kimodo_dir, run_command=run_command, log_cb=log_cb)
    if not kimodo_importable():
        raise RuntimeError(_kimodo_post_install_failure_message(kimodo_dir))


def pip_install_kimodo_editable() -> None:
    """Standalone pip install for scripts/manual use (attempts apt build deps on Linux)."""
    if kimodo_importable():
        return

    kimodo_dir = _ensure_kimodo_repo()

    if not python_dev_headers_ready():
        _run_apt_build_deps()
    require_python_dev_headers()
    _run_kimodo_editable_install(kimodo_dir)
    if not kimodo_importable():
        raise RuntimeError(_kimodo_post_install_failure_message(kimodo_dir))
