"""Persistent KiMoD text encoder (Gradio API on port 9550)."""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable

logger = logging.getLogger("motion_ref_gen")

_SERVICE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SERVICE_DIR.parents[1]
_KIMODO_SRC = _REPO_ROOT / "kimodo"

_DEFAULT_TEXT_ENCODER_PORT = 9550
_DEFAULT_READY_TIMEOUT = 600.0


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


def text_encoder_child_env(port: int | None = None) -> dict[str, str]:
    """Environment for the headless text encoder subprocess."""
    env = os.environ.copy()
    p = port if port is not None else text_encoder_port()
    env["GRADIO_SERVER_PORT"] = str(p)
    env["GRADIO_SERVER_NAME"] = "127.0.0.1"
    env["PYTHONPATH"] = _kimodo_pythonpath()
    if "TEXT_ENCODER_DEVICE" not in env:
        try:
            import torch

            env["TEXT_ENCODER_DEVICE"] = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            env["TEXT_ENCODER_DEVICE"] = "cpu"
    for key in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def motion_worker_child_env(port: int | None = None) -> dict[str, str]:
    """Environment for the motion worker — force API text encoder mode."""
    env = os.environ.copy()
    te_port = port if port is not None else text_encoder_port()
    env["TEXT_ENCODER_MODE"] = "api"
    env["TEXT_ENCODER_URL"] = text_encoder_url(te_port)
    env["PYTHONPATH"] = _kimodo_pythonpath()
    if "TEXT_ENCODER_DEVICE" not in env:
        try:
            import torch

            env["TEXT_ENCODER_DEVICE"] = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            env["TEXT_ENCODER_DEVICE"] = "cpu"
    return env


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
            raise RuntimeError(
                f"Text encoder worker exited (code {proc.returncode}).\n{tail}"
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

        device = text_encoder_child_env(p).get("TEXT_ENCODER_DEVICE", "cpu")
        if log_cb:
            log_cb(
                f"Starting KiMoD text encoder (Llama 3 8B on {device}, port {p}). "
                "First run may take several minutes while weights load…"
            )

        from services.kimodo_setup import apply_kimodo_patches

        apply_kimodo_patches(_KIMODO_SRC, log_cb=log_cb)

        cmd = [
            sys.executable,
            "-m",
            "kimodo.scripts.run_text_encoder_server",
            "--headless",
        ]
        _text_encoder_proc = subprocess.Popen(
            cmd,
            cwd=str(_REPO_ROOT),
            env=text_encoder_child_env(p),
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
