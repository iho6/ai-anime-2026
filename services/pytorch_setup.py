"""
PyTorch install helpers for local dev and startup (RTX 4090 / 5090 / Blackwell).

Installs from the official cu128 wheel index (torch 2.8+ includes sm_89 and sm_120).
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

PYTORCH_INDEX_URL = "https://download.pytorch.org/whl/cu128"
MIN_TORCH_VERSION = (2, 8, 0)

_REPO_ROOT = Path(__file__).resolve().parents[1]
_VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)")


def parse_torch_version(version: str) -> tuple[int, int, int] | None:
    m = _VERSION_RE.match((version or "").strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def torch_version_ok() -> bool:
    try:
        import torch
    except ImportError:
        return False
    parsed = parse_torch_version(torch.__version__)
    if parsed is None or parsed < MIN_TORCH_VERSION:
        return False
    # Require a CUDA wheel (+cu…) for GPU workflows.
    if "+cu" not in torch.__version__:
        return False
    return True


def torch_stack_needs_install() -> bool:
    return not torch_version_ok()


def torch_stack_info() -> dict[str, Any]:
    out: dict[str, Any] = {
        "torch_version": None,
        "cuda_version": None,
        "arch_list": [],
        "cuda_available": False,
        "device_count": 0,
        "device_name": None,
        "compute_capability": None,
    }
    try:
        import torch
    except ImportError:
        return out
    out["torch_version"] = torch.__version__
    out["cuda_version"] = getattr(torch.version, "cuda", None)
    out["cuda_available"] = bool(torch.cuda.is_available())
    get_arch = getattr(torch.cuda, "get_arch_list", None)
    if callable(get_arch):
        try:
            out["arch_list"] = list(get_arch())
        except Exception:
            pass
    if out["cuda_available"]:
        out["device_count"] = int(torch.cuda.device_count() or 0)
        if out["device_count"] > 0:
            try:
                out["device_name"] = str(torch.cuda.get_device_name(0))
                cap = torch.cuda.get_device_capability(0)
                out["compute_capability"] = f"{cap[0]}.{cap[1]}"
            except Exception:
                pass
    return out


def _pip_install_pytorch(*, log_cb: Callable[[str], None] | None) -> None:
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "torch",
        "torchvision",
        "torchaudio",
        "--index-url",
        PYTORCH_INDEX_URL,
    ]
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
        raise RuntimeError(f"PyTorch install failed: {err}")


def ensure_pytorch_stack(*, log_cb: Callable[[str], None] | None = None) -> None:
    """Install or upgrade PyTorch cu128 2.8+ in the current interpreter environment."""
    if torch_version_ok():
        info = torch_stack_info()
        if log_cb:
            log_cb(
                f"PyTorch OK: {info.get('torch_version')} "
                f"(cuda={info.get('cuda_version')})"
            )
        return
    if log_cb:
        log_cb("Installing PyTorch (cu128, 2.8+) from PyTorch index…")
    _pip_install_pytorch(log_cb=log_cb)
    if not torch_version_ok():
        raise RuntimeError(
            "PyTorch install completed but version check failed "
            f"(need >={'.'.join(map(str, MIN_TORCH_VERSION))} with +cu CUDA wheels)"
        )
    if log_cb:
        info = torch_stack_info()
        log_cb(
            f"PyTorch installed: {info.get('torch_version')} "
            f"(cuda={info.get('cuda_version')})"
        )
