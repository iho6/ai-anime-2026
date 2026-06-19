"""Shared CMake Python hints for MotionCorrection builds (stdlib-only)."""

from __future__ import annotations

import sys
import sysconfig
from pathlib import Path


def kimodo_build_packages() -> list[str]:
    py_tag = f"{sys.version_info.major}.{sys.version_info.minor}"
    return ["cmake", "build-essential", f"python{py_tag}-dev"]


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
    """CMake -D flags so find_package(Python3 Development) binds to this interpreter."""
    py_include = sysconfig.get_path("include")
    args = [
        f"-DPYTHON_EXECUTABLE={sys.executable}",
        f"-DPython3_EXECUTABLE={sys.executable}",
        f"-DPython3_INCLUDE_DIR={py_include}",
        "-DPython3_FIND_UNVERSIONED_NAMES=OFF",
    ]
    py_lib = sysconfig.get_config_var("LIBRARY")
    if py_lib:
        args.append(f"-DPython3_LIBRARY={py_lib}")
    return args


def extra_cmake_args_from_env() -> list[str]:
    """Optional space-separated flags from KIMODO_CMAKE_ARGS."""
    import os

    raw = os.environ.get("KIMODO_CMAKE_ARGS", "").strip()
    if not raw:
        return []
    return raw.split()
