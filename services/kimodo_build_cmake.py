"""Shared CMake Python hints for MotionCorrection builds (stdlib-only)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import sysconfig
from pathlib import Path

_TARGET_PYTHON_ENV = "KIMODO_TARGET_PYTHON"


def kimodo_build_packages() -> list[str]:
    py_tag = f"{sys.version_info.major}.{sys.version_info.minor}"
    return ["cmake", "build-essential", f"python{py_tag}-dev"]


def target_python_executable() -> str:
    """Interpreter MotionCorrection should link against (venv when set via env)."""
    override = os.environ.get(_TARGET_PYTHON_ENV, "").strip()
    if override and Path(override).is_file():
        return override
    return sys.executable


def _sysconfig_for_executable(exe: str) -> tuple[str | None, str | None]:
    """Return (include_dir, library) for the given Python executable."""
    if exe == sys.executable:
        return sysconfig.get_path("include"), sysconfig.get_config_var("LIBRARY")

    code = (
        "import json, sysconfig; "
        "print(json.dumps({"
        "'include': sysconfig.get_path('include'), "
        "'library': sysconfig.get_config_var('LIBRARY')"
        "}))"
    )
    out = subprocess.check_output([exe, "-c", code], text=True, encoding="utf-8")
    data = json.loads(out)
    return data.get("include"), data.get("library")


def python_dev_headers_ready() -> bool:
    """True when Python.h is available for the active interpreter."""
    include = sysconfig.get_path("include")
    if not include:
        return False
    return (Path(include) / "Python.h").is_file()


def require_python_dev_headers() -> None:
    if python_dev_headers_ready():
        return
    packages = " ".join(kimodo_build_packages())
    include = sysconfig.get_path("include") or "(unknown)"
    raise RuntimeError(
        f"Python development headers missing for {sys.executable} "
        f"(expected Python.h under {include}). "
        f"Install: sudo apt-get install -y {packages}"
    )


def python_cmake_args() -> list[str]:
    """CMake -D flags so find_package(Python3 Development) binds to target interpreter."""
    exe = target_python_executable()
    py_include, py_lib = _sysconfig_for_executable(exe)
    args = [
        f"-DPYTHON_EXECUTABLE={exe}",
        f"-DPython3_EXECUTABLE={exe}",
        f"-DPython3_INCLUDE_DIR={py_include}",
        "-DPython3_FIND_UNVERSIONED_NAMES=OFF",
    ]
    if py_lib:
        args.append(f"-DPython3_LIBRARY={py_lib}")
    return args


def extra_cmake_args_from_env() -> list[str]:
    """Optional space-separated flags from KIMODO_CMAKE_ARGS."""
    raw = os.environ.get("KIMODO_CMAKE_ARGS", "").strip()
    if not raw:
        return []
    return raw.split()
