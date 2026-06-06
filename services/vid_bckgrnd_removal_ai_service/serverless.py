"""
Video background removal service — RobustVideoMatting (RVM).

Fully self-contained: no ComfyUI, no RunPod, no external HTTP dependencies.

Architecture: persistent HTTP worker
─────────────────────────────────────
On the first call from logic.py the module starts a background subprocess that
loads the RVM model once (~5–10 s) then listens on a local port forever.
All subsequent calls within the same FastAPI session skip straight to the HTTP
POST — zero model-load latency.

The worker process is ``python -m services.vid_bckgrnd_removal_ai_service.serverless --serve``.

Output
──────
WebM encoded with libvpx-vp9 + alpha (YUVA420P).  VP9 alpha is natively
supported in all modern browsers as a ``<video>`` source.

CLI (serve mode, called by the parent process):

    python -m services.vid_bckgrnd_removal_ai_service.serverless --serve
           [--serve-port 8765]
           [--backbone mobilenetv3|resnet50]
           [--device auto|cuda|cpu]
           [--downsample-ratio 0.25]

CLI (one-shot mode, for testing):

    python -m services.vid_bckgrnd_removal_ai_service.serverless \\
           --video-url /abs/path/input.mp4 \\
           [--output-path /abs/path/out.webm]

Public Python API (called by logic.py):

    from services.vid_bckgrnd_removal_ai_service.serverless import (
        remove_video_background_persistent,   # preferred — uses persistent worker
        remove_video_background,              # direct call (loads model in caller)
    )
"""

from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d - %(levelname)s - %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("vid_bckgrnd_removal")

# Repo root — needed when spawning the worker subprocess.
_SERVICE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SERVICE_DIR.parents[1]  # .../anime2026_refactored/

# ---------------------------------------------------------------------------
# Model cache  (populated in the worker process, not in the API process)
# ---------------------------------------------------------------------------

_MODEL_CACHE: dict[str, Any] = {}


def _load_model(backbone: str = "mobilenetv3", device: str = "cpu") -> Any:
    """Load and cache the RVM model.  Safe to call multiple times."""
    import torch

    key = f"{backbone}:{device}"
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]

    logger.info("Downloading / loading RVM (%s) via torch.hub…", backbone)
    model = torch.hub.load(
        "PeterL1n/RobustVideoMatting",
        backbone,
        trust_repo=True,
    )
    model = model.eval().to(device)
    if device.startswith("cuda"):
        model = model.half()  # fp16 on GPU — free 2× speed
    _MODEL_CACHE[key] = model
    logger.info("RVM model loaded on %s.", device)
    return model


# ---------------------------------------------------------------------------
# Core inference  (self-contained, importable directly)
# ---------------------------------------------------------------------------


def remove_video_background(
    input_path: str | Path,
    output_path: str | Path,
    *,
    backbone: str = "mobilenetv3",
    device: str = "auto",
    downsample_ratio: float = 0.25,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """
    Remove the background from every frame of *input_path* and write
    the result to *output_path* as a WebM / VP9-alpha video.

    Returns ``{"url": "/abs/path/out.webm", "fps": …, "width": …, "height": …}``.
    """
    import av
    import numpy as np
    import torch

    def _log(msg: str) -> None:
        logger.info(msg)
        if log_cb:
            log_cb(msg)

    inp = Path(input_path)
    out = Path(output_path)
    if not inp.is_file():
        raise ValueError(f"Input video not found: {inp}")
    out.parent.mkdir(parents=True, exist_ok=True)

    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    _log(f"Device: {device}")

    model = _load_model(backbone, device)
    use_fp16 = device.startswith("cuda")
    dtype = torch.float16 if use_fp16 else torch.float32

    # ── Input ─────────────────────────────────────────────────────────────
    in_container = av.open(str(inp))
    in_stream = in_container.streams.video[0]
    fps = float(in_stream.average_rate or in_stream.base_rate or 24)
    src_w = in_stream.width
    src_h = in_stream.height
    total = in_stream.frames or 0
    _log(
        f"Input: {inp.name}  {src_w}×{src_h}  {fps:.2f} fps"
        + (f"  {total} frames" if total else "")
    )

    # ── Output (WebM / VP9 + alpha) ────────────────────────────────────────
    out_container = av.open(str(out), mode="w", format="webm")
    out_stream = out_container.add_stream("libvpx-vp9", rate=fps)
    out_stream.width = src_w
    out_stream.height = src_h
    out_stream.pix_fmt = "yuva420p"
    out_stream.options = {
        "crf": "10",
        "b:v": "0",          # CRF mode requires b:v=0 for VP9
        "deadline": "realtime",
        "cpu-used": "8",     # fastest preset
        "row-mt": "1",
        "auto-alt-ref": "0", # must be off for alpha streams
    }

    # ── Inference ──────────────────────────────────────────────────────────
    rec = [None] * 4  # RVM recurrent state
    frame_idx = 0
    t0 = time.monotonic()

    with torch.no_grad():
        for packet in in_container.demux(in_stream):
            for av_frame in packet.decode():
                rgb = av_frame.to_ndarray(format="rgb24")  # (H, W, 3) uint8
                t = (
                    torch.from_numpy(rgb)
                    .permute(2, 0, 1)
                    .unsqueeze(0)
                    .to(device=device, dtype=dtype)
                    / 255.0
                )
                fgr, pha, *rec = model(t, *rec, downsample_ratio=downsample_ratio)

                fgr_np = (
                    fgr[0].permute(1, 2, 0).cpu().float().numpy() * 255
                ).clip(0, 255).astype("uint8")
                pha_np = (
                    pha[0, 0].cpu().float().numpy() * 255
                ).clip(0, 255).astype("uint8")

                rgba = np.dstack([fgr_np, pha_np])  # (H, W, 4)
                out_frame = av.VideoFrame.from_ndarray(rgba, format="rgba")
                out_frame = out_frame.reformat(format="yuva420p")
                out_frame.pts = frame_idx
                out_frame.time_base = out_stream.codec_context.time_base

                for pkt in out_stream.encode(out_frame):
                    out_container.mux(pkt)

                frame_idx += 1
                if frame_idx % 30 == 0:
                    elapsed = time.monotonic() - t0
                    fps_real = frame_idx / max(elapsed, 0.001)
                    progress = f"{frame_idx}/{total}" if total else str(frame_idx)
                    _log(f"  Frame {progress}  ({fps_real:.1f} fps processing)")

    for pkt in out_stream.encode(None):
        out_container.mux(pkt)

    out_container.close()
    in_container.close()

    elapsed = time.monotonic() - t0
    _log(f"Done — {frame_idx} frames in {elapsed:.1f}s → {out.name}")

    return {
        "url": str(out.resolve()),
        "fps": fps,
        "width": src_w,
        "height": src_h,
        "frames": frame_idx,
    }


# ---------------------------------------------------------------------------
# Persistent HTTP worker  (server side — runs inside the worker subprocess)
# ---------------------------------------------------------------------------

_DEFAULT_PORT = 8765
_DEFAULT_BACKBONE = "mobilenetv3"
_DEFAULT_DEVICE = "auto"
_DEFAULT_DS_RATIO = 0.25


def _make_request_handler(
    backbone: str,
    device: str,
    downsample_ratio: float,
) -> type:
    """Return a BaseHTTPRequestHandler subclass closed over server settings."""

    class _Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:  # silence access log
            logger.debug(fmt, *args)

        def _send_json(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send_json(200, {"ok": True})
            else:
                self.send_error(404)

        def do_POST(self) -> None:
            if self.path != "/process":
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode())

            video_url = (payload.get("video_url") or "").strip()
            output_path = (payload.get("output_path") or "").strip() or None
            ds_ratio = float(payload.get("downsample_ratio") or downsample_ratio)

            if not output_path:
                stem = Path(video_url).stem if video_url else "video"
                output_path = str(
                    Path(tempfile.gettempdir())
                    / f"{stem}_nobg_{uuid.uuid4().hex[:8]}.webm"
                )

            logs: list[str] = []
            try:
                result = remove_video_background(
                    video_url,
                    output_path,
                    backbone=backbone,
                    device=device,
                    downsample_ratio=ds_ratio,
                    log_cb=lambda msg: logs.append(msg),
                )
                self._send_json(200, {"results": [result], "error": None, "logs": logs})
            except Exception as exc:
                logger.exception("Processing failed")
                self._send_json(
                    200,
                    {"results": [], "error": str(exc), "logs": logs},
                )

    return _Handler


def serve_forever(
    port: int = _DEFAULT_PORT,
    backbone: str = _DEFAULT_BACKBONE,
    device: str = _DEFAULT_DEVICE,
    downsample_ratio: float = _DEFAULT_DS_RATIO,
) -> None:
    """
    Load model once, then serve ``POST /process`` + ``GET /health`` forever.
    This is the entry point for the ``--serve`` CLI flag.
    """
    if device == "auto":
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"

    logger.info("Pre-loading RVM (%s) on %s…", backbone, device)
    _load_model(backbone, device)
    logger.info("Model ready.  Starting HTTP server on 127.0.0.1:%d", port)

    handler_cls = _make_request_handler(backbone, device, downsample_ratio)
    httpd = HTTPServer(("127.0.0.1", port), handler_cls)

    # Signal readiness to the parent process (read in _wait_for_server below).
    print(f"READY:{port}", flush=True)
    logger.info("RVM server listening on port %d", port)

    httpd.serve_forever()


# ---------------------------------------------------------------------------
# Persistent worker  (client side — called from logic.py / the API process)
# ---------------------------------------------------------------------------

_worker_lock = threading.Lock()
_worker_proc: subprocess.Popen | None = None  # type: ignore[type-arg]
_worker_port: int = _DEFAULT_PORT


def _server_is_up(port: int) -> bool:
    import urllib.request

    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/health", timeout=2
        ) as r:
            return r.status == 200
    except Exception:
        return False


def _wait_for_server(
    proc: subprocess.Popen,  # type: ignore[type-arg]
    port: int,
    timeout: float = 120.0,
    log_cb: Callable[[str], None] | None = None,
) -> None:
    """
    Wait until the server signals READY on stdout or the health check passes,
    whichever comes first.  Raises RuntimeError on timeout or process crash.
    """
    deadline = time.monotonic() + timeout
    ready_event = threading.Event()
    stderr_lines: list[str] = []

    def _read_stdout() -> None:
        for line in proc.stdout:  # type: ignore[union-attr]
            line = line.strip()
            if line.startswith("READY:"):
                ready_event.set()
                break
            if log_cb:
                log_cb(f"[rvm-server] {line}")

    def _read_stderr() -> None:
        for line in proc.stderr:  # type: ignore[union-attr]
            line = line.strip()
            stderr_lines.append(line)
            logger.debug("[rvm-server] %s", line)
            if log_cb:
                log_cb(f"[rvm-server] {line}")

    threading.Thread(target=_read_stdout, daemon=True).start()
    threading.Thread(target=_read_stderr, daemon=True).start()

    while time.monotonic() < deadline:
        if ready_event.is_set() or _server_is_up(port):
            return
        if proc.poll() is not None:
            tail = "\n".join(stderr_lines[-10:])
            raise RuntimeError(
                f"RVM worker exited unexpectedly (code {proc.returncode}).\n{tail}"
            )
        time.sleep(0.25)

    raise RuntimeError(
        f"RVM worker did not become ready within {timeout:.0f}s "
        f"(port {port})."
    )


def _ensure_worker(
    port: int = _DEFAULT_PORT,
    backbone: str = _DEFAULT_BACKBONE,
    device: str = _DEFAULT_DEVICE,
    downsample_ratio: float = _DEFAULT_DS_RATIO,
    log_cb: Callable[[str], None] | None = None,
) -> str:
    """Start the persistent worker if not already running.  Thread-safe."""
    global _worker_proc, _worker_port

    with _worker_lock:
        _worker_port = port

        if _server_is_up(port):
            return f"http://127.0.0.1:{port}"

        # Dead or never started.
        if _worker_proc is not None and _worker_proc.poll() is None:
            # Process is alive but not yet healthy — wait for it.
            _wait_for_server(_worker_proc, port, log_cb=log_cb)
            return f"http://127.0.0.1:{port}"

        if log_cb:
            log_cb(
                f"Starting RVM worker (backbone={backbone}, device={device}, "
                f"port={port}) — model loads once, ~5–15 s…"
            )
        logger.info("Spawning RVM worker subprocess…")

        cmd = [
            sys.executable,
            "-m",
            "services.vid_bckgrnd_removal_ai_service.serverless",
            "--serve",
            "--serve-port", str(port),
            "--backbone", backbone,
            "--device", device,
            "--downsample-ratio", str(downsample_ratio),
        ]
        _worker_proc = subprocess.Popen(
            cmd,
            cwd=str(_REPO_ROOT),
            stdout=subprocess.PIPE,  # we read READY: signal from here
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

        _wait_for_server(_worker_proc, port, log_cb=log_cb)

        if log_cb:
            log_cb(f"RVM worker ready on port {port}.")
        logger.info("RVM worker ready on port %d.", port)
        return f"http://127.0.0.1:{port}"


def remove_video_background_persistent(
    video_path: str | Path,
    output_path: str | Path | None = None,
    *,
    backbone: str = _DEFAULT_BACKBONE,
    device: str = _DEFAULT_DEVICE,
    downsample_ratio: float = _DEFAULT_DS_RATIO,
    serve_port: int = _DEFAULT_PORT,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """
    Remove the background from *video_path* via the persistent RVM worker.

    On the first call the worker is started (model loaded once, ~5–15 s).
    All subsequent calls in the same server session are fast — no model reload.

    Returns the same dict as ``remove_video_background``:
    ``{"url": "/abs/path/out.webm", "fps": …, "width": …, "height": …}``.
    """
    import urllib.request

    base_url = _ensure_worker(
        port=serve_port,
        backbone=backbone,
        device=device,
        downsample_ratio=downsample_ratio,
        log_cb=log_cb,
    )

    payload = json.dumps(
        {
            "video_url": str(video_path),
            "output_path": str(output_path) if output_path else None,
            "downsample_ratio": downsample_ratio,
        }
    ).encode()

    if log_cb:
        log_cb("Sending video to RVM worker for processing…")

    req = urllib.request.Request(
        f"{base_url}/process",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    # Video processing can take several minutes — no hard timeout.
    with urllib.request.urlopen(req, timeout=7200) as resp:  # 2-hour safety cap
        body = json.loads(resp.read().decode())

    if body.get("logs") and log_cb:
        for line in body["logs"]:
            log_cb(line)

    if body.get("error"):
        raise RuntimeError(body["error"])

    results = body.get("results") or []
    if not results:
        raise RuntimeError("RVM worker returned no results.")

    return results[0]


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Video background removal — RVM")
    mode = p.add_mutually_exclusive_group()
    mode.add_argument(
        "--serve",
        action="store_true",
        help="Run as a persistent HTTP worker (model loaded once at startup).",
    )
    p.add_argument("--serve-port", type=int, default=_DEFAULT_PORT)
    p.add_argument("--backbone", type=str, default=_DEFAULT_BACKBONE,
                   choices=["mobilenetv3", "resnet50"])
    p.add_argument("--device", type=str, default="auto")
    p.add_argument("--downsample-ratio", type=float, default=_DEFAULT_DS_RATIO)
    # One-shot mode args.
    p.add_argument("--video-url", type=str, default=None)
    p.add_argument("--output-path", type=str, default=None)
    return p.parse_args()


def main() -> None:
    args = _parse_args()

    if args.serve:
        serve_forever(
            port=args.serve_port,
            backbone=args.backbone,
            device=args.device,
            downsample_ratio=args.downsample_ratio,
        )
        return  # serve_forever loops indefinitely

    # One-shot mode (testing).
    if not args.video_url:
        print(json.dumps({"results": [], "error": "--video-url is required"}))
        sys.exit(1)

    output = args.output_path or str(
        Path(tempfile.gettempdir())
        / f"{Path(args.video_url).stem}_nobg_{uuid.uuid4().hex[:8]}.webm"
    )

    try:
        result = remove_video_background(
            args.video_url,
            output,
            backbone=args.backbone,
            device=args.device,
            downsample_ratio=args.downsample_ratio,
            log_cb=lambda msg: print(msg, file=sys.stderr),
        )
        print(json.dumps({"results": [result], "error": None}))
    except Exception as exc:
        logger.exception("Fatal error")
        print(json.dumps({"results": [], "error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
