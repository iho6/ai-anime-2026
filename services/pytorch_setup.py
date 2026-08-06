"""
PyTorch install helpers for local dev and startup (RTX 40 / 50 / Blackwell).

Default index is cu128 (torch 2.8+ includes sm_89 and sm_120). Override with
``ANIME2026_TORCH_PROFILE=rtx40|rtx50|cu128`` so only the torch stack is
swapped when moving the Seagate checkout between GPU generations — the rest
of ``.venv`` stays intact.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

# Profile → (index URL, minimum torch version tuple)
_TORCH_PROFILES: dict[str, tuple[str, tuple[int, int, int]]] = {
    # Ada / RTX 40-class: stable cu124 line
    "rtx40": ("https://download.pytorch.org/whl/cu124", (2, 4, 0)),
    # Blackwell / RTX 50-class (and default portable stack)
    "rtx50": ("https://download.pytorch.org/whl/cu128", (2, 8, 0)),
    "cu128": ("https://download.pytorch.org/whl/cu128", (2, 8, 0)),
}

DEFAULT_TORCH_PROFILE = "cu128"
PYTORCH_INDEX_URL = _TORCH_PROFILES[DEFAULT_TORCH_PROFILE][0]
MIN_TORCH_VERSION = _TORCH_PROFILES[DEFAULT_TORCH_PROFILE][1]

_REPO_ROOT = Path(__file__).resolve().parents[1]
_VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)")
_PROFILE_SENTINEL_NAME = ".torch-profile"


def resolve_torch_profile() -> str:
    """Return normalized profile name from env (default ``cu128``)."""
    raw = (os.environ.get("ANIME2026_TORCH_PROFILE") or "").strip().lower()
    if not raw:
        return DEFAULT_TORCH_PROFILE
    if raw in ("40", "ada", "rtx4090", "rtx_40"):
        return "rtx40"
    if raw in ("50", "blackwell", "rtx5090", "rtx_50"):
        return "rtx50"
    if raw not in _TORCH_PROFILES:
        raise ValueError(
            f"Unknown ANIME2026_TORCH_PROFILE={raw!r}; "
            f"expected one of {sorted(_TORCH_PROFILES)}"
        )
    return raw


def torch_profile_config(profile: str | None = None) -> tuple[str, str, tuple[int, int, int]]:
    """Return ``(profile_name, index_url, min_version)``."""
    name = resolve_torch_profile() if profile is None else str(profile).strip().lower()
    if name not in _TORCH_PROFILES:
        raise ValueError(f"Unknown torch profile: {name!r}")
    index, minimum = _TORCH_PROFILES[name]
    return name, index, minimum


def _profile_sentinel_path() -> Path:
    # Prefer the active venv prefix so the marker travels with site-packages.
    return Path(sys.prefix) / _PROFILE_SENTINEL_NAME


def read_installed_torch_profile() -> str | None:
    p = _profile_sentinel_path()
    if not p.is_file():
        return None
    try:
        return p.read_text(encoding="utf-8").strip().lower() or None
    except OSError:
        return None


def write_installed_torch_profile(profile: str) -> None:
    p = _profile_sentinel_path()
    try:
        p.write_text(str(profile).strip().lower() + "\n", encoding="utf-8")
    except OSError:
        pass


def parse_torch_version(version: str) -> tuple[int, int, int] | None:
    m = _VERSION_RE.match((version or "").strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def torch_version_ok(*, min_version: tuple[int, int, int] | None = None) -> bool:
    try:
        import torch
    except ImportError:
        return False
    minimum = min_version if min_version is not None else MIN_TORCH_VERSION
    parsed = parse_torch_version(torch.__version__)
    if parsed is None or parsed < minimum:
        return False
    # Require a CUDA wheel (+cu…) for GPU workflows.
    if "+cu" not in torch.__version__:
        return False
    return True


def torch_stack_needs_install() -> bool:
    profile, _index, minimum = torch_profile_config()
    if read_installed_torch_profile() not in (None, profile):
        return True
    return not torch_version_ok(min_version=minimum)


def torch_stack_info() -> dict[str, Any]:
    out: dict[str, Any] = {
        "torch_version": None,
        "cuda_version": None,
        "arch_list": [],
        "cuda_available": False,
        "device_count": 0,
        "device_name": None,
        "compute_capability": None,
        "profile": resolve_torch_profile(),
        "index_url": torch_profile_config()[1],
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


def _pip_install_pytorch(
    *,
    index_url: str,
    log_cb: Callable[[str], None] | None,
) -> None:
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--upgrade",
        "torch",
        "torchvision",
        "torchaudio",
        "--index-url",
        index_url,
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


def ensure_pytorch_stack(
    *,
    log_cb: Callable[[str], None] | None = None,
    force: bool = False,
) -> None:
    """Install or upgrade PyTorch for the active ``ANIME2026_TORCH_PROFILE``.

    Changing the profile (or passing ``force=True``) reinstalls only torch /
    torchvision / torchaudio — the rest of the venv is left alone.
    """
    profile, index_url, minimum = torch_profile_config()
    prev = read_installed_torch_profile()
    profile_changed = prev is not None and prev != profile
    need = force or profile_changed or not torch_version_ok(min_version=minimum)

    if not need:
        info = torch_stack_info()
        if log_cb:
            log_cb(
                f"PyTorch OK [{profile}]: {info.get('torch_version')} "
                f"(cuda={info.get('cuda_version')})"
            )
        if prev is None:
            write_installed_torch_profile(profile)
        return

    if log_cb:
        why = "forced" if force else ("profile change" if profile_changed else "missing/outdated")
        log_cb(
            f"Installing PyTorch profile={profile} ({why}) from {index_url}…"
        )
    _pip_install_pytorch(index_url=index_url, log_cb=log_cb)
    if not torch_version_ok(min_version=minimum):
        raise RuntimeError(
            "PyTorch install completed but version check failed "
            f"(need >={'.'.join(map(str, minimum))} with +cu CUDA wheels "
            f"for profile={profile})"
        )
    write_installed_torch_profile(profile)
    if log_cb:
        info = torch_stack_info()
        log_cb(
            f"PyTorch installed [{profile}]: {info.get('torch_version')} "
            f"(cuda={info.get('cuda_version')})"
        )
