"""Persistent KiMoD text encoder (Gradio API on port 9550)."""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

logger = logging.getLogger("motion_ref_gen")

_SERVICE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SERVICE_DIR.parents[1]
_KIMODO_SRC = _REPO_ROOT / "kimodo"
_API_SETTINGS_FILE = _REPO_ROOT / "storage" / "api_settings.json"

_DEFAULT_TEXT_ENCODER_PORT = 9550
_DEFAULT_READY_TIMEOUT = 600.0

_HF_TOKEN_ENV_KEYS = (
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "HUGGING_FACE_HUB_TOKEN",
)


def text_encoder_port() -> int:
    raw = os.environ.get("KIMODO_TEXT_ENCODER_PORT", "").strip()
    if raw:
        return int(raw)
    return _DEFAULT_TEXT_ENCODER_PORT


def text_encoder_ready_timeout() -> float:
    raw = os.environ.get("KIMODO_TEXT_ENCODER_READY_TIMEOUT", "").strip()
    if raw:
        return float(raw)
    return _DEFAULT_READY_TIMEOUT


def text_encoder_url(port: int | None = None) -> str:
    p = port if port is not None else text_encoder_port()
    return f"http://127.0.0.1:{p}/"


def motion_worker_ready_timeout() -> float:
    raw = os.environ.get("KIMODO_MOTION_WORKER_READY_TIMEOUT", "").strip()
    if raw:
        return float(raw)
    return 300.0


def _prepend_kimodo_src() -> None:
    src = str(_KIMODO_SRC)
    if src not in sys.path:
        sys.path.insert(0, src)


def _kimodo_pythonpath() -> str:
    src = str(_KIMODO_SRC)
    existing = os.environ.get("PYTHONPATH", "")
    return f"{src}{os.pathsep}{existing}" if existing else src


def _sanitize_hf_token(token: str) -> str:
    t = (token or "").replace("\r", "").replace("\n", "").strip()
    if len(t) >= 2 and t[0] == t[-1] and t[0] in ("'", '"'):
        t = t[1:-1].strip()
    return t


def resolve_hf_token() -> str:
    """HF token for gated Llama / Kimodo downloads.

    Prefer process env (set by API startup / Settings), then
    ``storage/api_settings.json`` so text-encoder children still auth when the
    parent process was started without the env var already exported.
    """
    for key in _HF_TOKEN_ENV_KEYS:
        val = _sanitize_hf_token(os.environ.get(key) or "")
        if val:
            return val
    try:
        if _API_SETTINGS_FILE.is_file():
            data = json.loads(_API_SETTINGS_FILE.read_text(encoding="utf-8"))
            val = _sanitize_hf_token(str(data.get("hf_token") or ""))
            if val:
                return val
    except Exception:
        pass
    return ""


def validate_hf_token(token: str) -> None:
    """Fail fast when the saved HF token is revoked/wrong (common 401 cause)."""
    token = _sanitize_hf_token(token)
    if not token:
        raise RuntimeError("HF_TOKEN is empty.")
    if not token.startswith("hf_"):
        raise RuntimeError(
            "Saved token does not look like a Hugging Face token (expected prefix 'hf_'). "
            "Paste an HF access token from https://huggingface.co/settings/tokens — "
            "not a GitHub PAT."
        )
    try:
        from huggingface_hub import HfApi

        HfApi().whoami(token=token)
    except Exception as exc:
        raise RuntimeError(
            "Saved Hugging Face token is invalid or revoked "
            f"({type(exc).__name__}). Update it in Settings (gear) or Install Dependencies "
            "with a new read token from https://huggingface.co/settings/tokens, "
            "and accept access at https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct"
        ) from exc


def _runtime_hf_token_path() -> Path:
    return _REPO_ROOT / "storage" / ".hf_token_runtime"


def _stage_hf_token_file(token: str) -> Path:
    path = _runtime_hf_token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding="utf-8")
    return path


def _inject_hf_token(env: dict[str, str]) -> str:
    """Write HF token into all common env aliases used by huggingface_hub."""
    token = resolve_hf_token()
    if not token:
        return ""
    for key in _HF_TOKEN_ENV_KEYS:
        env[key] = token
    token_path = _stage_hf_token_file(token)
    env["KIMODO_HF_TOKEN_FILE"] = str(token_path)
    # Keep parent process consistent for later child spawns.
    for key in _HF_TOKEN_ENV_KEYS:
        if not _sanitize_hf_token(os.environ.get(key) or ""):
            os.environ[key] = token
    return token


def _stringify_env(env: dict[str, str]) -> dict[str, str]:
    """Windows CreateProcess requires a clean str→str environment block."""
    out: dict[str, str] = {}
    for key, value in env.items():
        if value is None:
            continue
        out[str(key)] = str(value)
    return out


def text_encoder_child_env(port: int | None = None) -> dict[str, str]:
    """Environment for the headless text encoder subprocess."""
    env = os.environ.copy()
    p = port if port is not None else text_encoder_port()
    env["GRADIO_SERVER_PORT"] = str(p)
    env["GRADIO_SERVER_NAME"] = "127.0.0.1"
    env["PYTHONPATH"] = _kimodo_pythonpath()
    # Windows often lacks symlink privilege; avoid noisy HF cache warnings.
    env.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    # Gradio 6 rejects /tmp-style paths outside OS temp / cwd.
    env.setdefault(
        "TEXT_ENCODER_TMP_FOLDER",
        os.path.join(tempfile.gettempdir(), "kimodo_text_encoder"),
    )
    if "TEXT_ENCODER_DEVICE" not in env:
        try:
            import torch

            env["TEXT_ENCODER_DEVICE"] = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            env["TEXT_ENCODER_DEVICE"] = "cpu"
    _inject_hf_token(env)
    return _stringify_env(env)


def motion_worker_child_env(port: int | None = None) -> dict[str, str]:
    """Environment for the motion worker — force API text encoder mode."""
    env = os.environ.copy()
    te_port = port if port is not None else text_encoder_port()
    env["TEXT_ENCODER_MODE"] = "api"
    env["TEXT_ENCODER_URL"] = text_encoder_url(te_port)
    env["PYTHONPATH"] = _kimodo_pythonpath()
    env.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    if "TEXT_ENCODER_DEVICE" not in env:
        try:
            import torch

            env["TEXT_ENCODER_DEVICE"] = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            env["TEXT_ENCODER_DEVICE"] = "cpu"
    _inject_hf_token(env)
    return _stringify_env(env)


def _text_encoder_is_up(port: int | None = None) -> bool:
    p = port if port is not None else text_encoder_port()
    url = text_encoder_url(p)
    try:
        _prepend_kimodo_src()
        from kimodo.model.text_encoder_api import TextEncoderAPI

        client = TextEncoderAPI(url=url)
        client(["healthcheck"])
        return True
    except Exception:
        return False


_text_encoder_lock = threading.Lock()
_text_encoder_proc: subprocess.Popen | None = None  # type: ignore[type-arg]
_text_encoder_port_value: int = _DEFAULT_TEXT_ENCODER_PORT


def _wait_for_text_encoder(
    proc: subprocess.Popen,  # type: ignore[type-arg]
    port: int,
    timeout: float,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    deadline = time.monotonic() + timeout
    ready_event = threading.Event()
    stderr_lines: list[str] = []

    def _read_stdout() -> None:
        for line in proc.stdout:  # type: ignore[union-attr]
            line = line.strip()
            if line.startswith("READY:"):
                ready_event.set()
                break
            if log_cb and line:
                log_cb(f"[text-encoder] {line}")

    def _read_stderr() -> None:
        for line in proc.stderr:  # type: ignore[union-attr]
            line = line.strip()
            if line:
                stderr_lines.append(line)
            if log_cb and line:
                log_cb(f"[text-encoder] {line}")

    threading.Thread(target=_read_stdout, daemon=True).start()
    threading.Thread(target=_read_stderr, daemon=True).start()

    while time.monotonic() < deadline:
        if ready_event.is_set() or _text_encoder_is_up(port):
            return
        if proc.poll() is not None:
            tail = "\n".join(stderr_lines[-15:])
            hint = ""
            joined = "\n".join(stderr_lines)
            if "GatedRepoError" in joined or "gated repo" in joined.lower() or "401" in joined:
                hint = (
                    "\n\nHugging Face gated model access failed. "
                    "1) Request access at https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct "
                    "2) Put a read token in Settings (gear) / startup HF token "
                    "(same token as Install Dependencies)."
                )
            raise RuntimeError(
                f"Text encoder worker exited (code {proc.returncode}).\n{tail}{hint}"
            )
        time.sleep(0.3)

    raise RuntimeError(
        f"Text encoder did not become ready on port {port} within {timeout:.0f}s."
    )


def ensure_text_encoder(
    log_cb: Callable[[str], None] | None = None,
    *,
    port: int | None = None,
) -> str:
    """Start the persistent KiMoD text encoder if not already running."""
    global _text_encoder_proc, _text_encoder_port_value

    p = port if port is not None else text_encoder_port()
    timeout = text_encoder_ready_timeout()

    with _text_encoder_lock:
        _text_encoder_port_value = p

        if _text_encoder_is_up(p):
            return text_encoder_url(p)

        if _text_encoder_proc is not None and _text_encoder_proc.poll() is None:
            _wait_for_text_encoder(_text_encoder_proc, p, timeout, log_cb=log_cb)
            return text_encoder_url(p)

        child_env = text_encoder_child_env(p)
        device = child_env.get("TEXT_ENCODER_DEVICE", "cpu")
        if log_cb:
            log_cb(
                f"Starting KiMoD text encoder (Llama 3 8B on {device}, port {p}). "
                "First run may take several minutes while weights load…"
            )

        token = resolve_hf_token()
        if not token:
            raise RuntimeError(
                "HF_TOKEN is missing — Llama 3 text encoder is a gated Hugging Face model. "
                "Set your token in Settings (gear) or on the Install Dependencies screen, "
                "and accept https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct"
            )
        if log_cb:
            log_cb(
                "Using saved Hugging Face token for gated Llama / LLM2Vec download "
                f"(child env HF_TOKEN={'yes' if bool(child_env.get('HF_TOKEN')) else 'no'}, "
                f"prefix_ok={'yes' if token.startswith('hf_') else 'no'})."
            )
        try:
            if log_cb:
                log_cb("Validating Hugging Face token…")
            validate_hf_token(token)
            if log_cb:
                log_cb("Hugging Face token OK.")
        except RuntimeError as exc:
            if log_cb:
                log_cb(f"[ERROR] {exc}")
            raise

        from services.kimodo_setup import (
            _ensure_kimodo_repo,
            apply_kimodo_patches,
            ensure_kimodo_runtime_deps,
        )

        # Overlays alone leave an empty gitlink looking "installed" (setup.py present)
        # without kimodo.model — ensure a real upstream checkout first.
        _ensure_kimodo_repo(log_cb=log_cb)
        apply_kimodo_patches(_KIMODO_SRC, log_cb=log_cb)
        ensure_kimodo_runtime_deps(log_cb=log_cb)

        cmd = [
            sys.executable,
            "-m",
            "kimodo.scripts.run_text_encoder_server",
            "--headless",
        ]
        _text_encoder_proc = subprocess.Popen(
            cmd,
            cwd=str(_REPO_ROOT),
            env=child_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        _wait_for_text_encoder(_text_encoder_proc, p, timeout, log_cb=log_cb)

        if log_cb:
            log_cb(f"Text encoder ready on port {p}.")
        logger.info("KiMoD text encoder ready on port %d.", p)
        return text_encoder_url(p)
