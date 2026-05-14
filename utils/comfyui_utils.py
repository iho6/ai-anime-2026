"""HTTP helpers for a local ComfyUI server (same routes as ComfyUI script_examples / OpenAPI)."""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any
from urllib.parse import urlencode

import requests
from utils.comfyui_logging import ComfyJobContext, ComfyLogger, NullComfyLogger


class ComfyPromptError(RuntimeError):
    """Raised when ComfyUI rejects or fails a workflow submission."""


def probe_comfy_or_raise(comfy_url: str, *, timeout_s: float = 2.0) -> None:
    """Fail fast if ComfyUI isn't reachable.

    Uses a simple GET to `/system_stats` which is cheap and indicates the server
    is up before running heavier upload/queue actions.
    """
    base = str(comfy_url).rstrip("/")
    url = f"{base}/system_stats"
    try:
        r = requests.get(url, timeout=timeout_s)
        r.raise_for_status()
    except Exception as exc:
        raise RuntimeError(
            f"ComfyUI not reachable at {base!r} (probe: GET /system_stats). "
            "Start ComfyUI (or set --comfy-url correctly) and retry."
        ) from exc


def _detail_is_debug() -> bool:
    return os.environ.get("COMFY_LOG_DETAIL", "").strip().lower() in {"1", "true", "yes", "debug"}


class ComfyPhaseTracker:
    """
    Minimal lifecycle tracker for request-level phase logs.

    Stable high-signal events:
    - ``job.sent``: prompt accepted by Comfy queue (prompt_id known).
    - ``job.running``: first runtime execution signal observed.
    - ``job.returned``: terminal execution status observed.
    """

    def __init__(self, logger: ComfyLogger | None = None, ctx: ComfyJobContext | None = None):
        self._log = logger or NullComfyLogger()
        self._ctx = ctx
        self._sent = False
        self._running = False
        self._returned = False
        self._lock = threading.Lock()
        self._started_at = time.monotonic()

    def mark_sent(self, *, prompt_id: str, queue_number: float | int | None = None) -> None:
        with self._lock:
            if self._sent:
                return
            self._sent = True
            if self._ctx is not None:
                self._ctx.prompt_id = prompt_id
        data: dict[str, Any] = {"prompt_id": prompt_id}
        if queue_number is not None:
            data["queue_number"] = queue_number
        self._log.event(event="job.sent", ctx=self._ctx, data=data)

    def mark_running(self, *, source: str, node_id: str | None = None) -> None:
        with self._lock:
            if self._running:
                return
            self._running = True
        data: dict[str, Any] = {"source": source}
        if node_id is not None:
            data["node_id"] = node_id
        self._log.event(
            event="job.running",
            ctx=self._ctx,
            elapsed_ms=int((time.monotonic() - self._started_at) * 1000),
            data=data,
        )

    def mark_returned(
        self,
        *,
        result: str,
        source: str,
        outputs_count: int | None = None,
        error: str | None = None,
        error_type: str | None = None,
    ) -> None:
        with self._lock:
            if self._returned:
                return
            self._returned = True
        data: dict[str, Any] = {"result": result, "source": source}
        if outputs_count is not None:
            data["outputs_count"] = outputs_count
        if error:
            data["error"] = error
        if error_type:
            data["error_type"] = error_type
        self._log.event(
            event="job.returned",
            level="info" if result == "success" else "error",
            ctx=self._ctx,
            elapsed_ms=int((time.monotonic() - self._started_at) * 1000),
            data=data,
        )


class _ComfyWsLifecycleListener:
    """Optional websocket listener for runtime lifecycle events."""

    def __init__(
        self,
        base_url: str,
        client_id: str,
        prompt_id: str,
        tracker: ComfyPhaseTracker,
        logger: ComfyLogger,
        ctx: ComfyJobContext | None,
    ):
        self._base_url = base_url.rstrip("/")
        self._client_id = client_id
        self._prompt_id = prompt_id
        self._tracker = tracker
        self._log = logger
        self._ctx = ctx
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        try:
            import websocket  # type: ignore
        except Exception:
            if _detail_is_debug():
                self._log.event(
                    event="ws.lifecycle.unavailable",
                    level="debug",
                    ctx=self._ctx,
                    data={"reason": "websocket-client-not-installed"},
                )
            return

        def _run() -> None:
            ws_url = self._base_url.replace("http://", "ws://").replace("https://", "wss://")
            ws_url = f"{ws_url}/ws?clientId={self._client_id}"
            ws = None
            try:
                ws = websocket.WebSocket()  # type: ignore[attr-defined]
                ws.settimeout(0.5)
                ws.connect(ws_url)
                while not self._stop.is_set():
                    try:
                        out = ws.recv()
                    except Exception:
                        continue
                    if not isinstance(out, str):
                        continue
                    try:
                        msg = json.loads(out)
                    except Exception:
                        continue
                    event_type = msg.get("type")
                    data = msg.get("data") or {}
                    if data.get("prompt_id") != self._prompt_id:
                        continue
                    if event_type in {"execution_start", "executing"}:
                        self._tracker.mark_running(source=f"ws:{event_type}", node_id=str(data.get("node")))
                    elif event_type == "execution_success":
                        self._tracker.mark_returned(result="success", source="ws:execution_success")
                        return
                    elif event_type == "execution_interrupted":
                        self._tracker.mark_returned(result="cancelled", source="ws:execution_interrupted")
                        return
                    elif event_type == "execution_error":
                        self._tracker.mark_returned(
                            result="failed",
                            source="ws:execution_error",
                            error=str(data.get("exception_message") or ""),
                            error_type=str(data.get("exception_type") or ""),
                        )
                        return
            except Exception as e:
                if _detail_is_debug():
                    self._log.event(
                        event="ws.lifecycle.error",
                        level="debug",
                        ctx=self._ctx,
                        data={"error": str(e), "error_type": type(e).__name__},
                    )
            finally:
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:
                        pass

        self._thread = threading.Thread(target=_run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()


def upload_image(
    base_url: str,
    png_bytes: bytes,
    filename: str,
    *,
    timeout: int = 120,
    logger: ComfyLogger | None = None,
    ctx: ComfyJobContext | None = None,
) -> str:
    """POST /upload/image; return stored ``name`` for LoadImage nodes."""
    log = logger or NullComfyLogger()
    t0 = time.monotonic()
    base = base_url.rstrip("/")
    files = {"image": (filename, png_bytes, "image/png")}
    data = {"type": "input", "overwrite": "true"}
    log.event(
        event="upload.start",
        level="debug",
        ctx=ctx,
        data={"filename": filename, "timeout": timeout, "bytes": len(png_bytes)},
    )
    try:
        r = requests.post(f"{base}/upload/image", files=files, data=data, timeout=timeout)
        r.raise_for_status()
        body = r.json()
        log.event(
            event="upload.ok",
            level="debug",
            ctx=ctx,
            elapsed_ms=int((time.monotonic() - t0) * 1000),
            data={"filename": filename, "stored_name": body.get("name")},
        )
        return body["name"]
    except Exception as e:
        log.event(
            event="upload.error",
            level="error",
            ctx=ctx,
            elapsed_ms=int((time.monotonic() - t0) * 1000),
            data={"filename": filename, "error": str(e), "error_type": type(e).__name__},
        )
        raise


def queue_prompt(
    base_url: str,
    workflow: dict[str, Any],
    client_id: str,
    *,
    timeout: int = 120,
    logger: ComfyLogger | None = None,
    ctx: ComfyJobContext | None = None,
    phase_tracker: ComfyPhaseTracker | None = None,
) -> dict[str, Any]:
    """POST /prompt; returns JSON including ``prompt_id`` or raises."""
    log = logger or NullComfyLogger()
    t0 = time.monotonic()
    base = base_url.rstrip("/")
    log.event(event="prompt.queue.start", ctx=ctx, data={"timeout": timeout, "client_id": client_id})
    try:
        r = requests.post(
            f"{base}/prompt",
            json={"prompt": workflow, "client_id": client_id},
            timeout=timeout,
        )
        body = r.json() if r.content else {}
        if r.status_code >= 400:
            err = body.get("error", r.text)
            log.event(
                event="prompt.queue.error",
                level="error",
                ctx=ctx,
                elapsed_ms=int((time.monotonic() - t0) * 1000),
                data={"status_code": r.status_code, "error": err},
            )
            raise ComfyPromptError(f"ComfyUI prompt error ({r.status_code}): {err}")
        if "error" in body and body["error"]:
            log.event(
                event="prompt.queue.error",
                level="error",
                ctx=ctx,
                elapsed_ms=int((time.monotonic() - t0) * 1000),
                data={"error": body["error"]},
            )
            raise ComfyPromptError(f"ComfyUI prompt error: {body['error']}")
        if "prompt_id" not in body:
            log.event(
                event="prompt.queue.error",
                level="error",
                ctx=ctx,
                elapsed_ms=int((time.monotonic() - t0) * 1000),
                data={"error": "missing_prompt_id", "response": body},
            )
            raise ComfyPromptError(f"Unexpected prompt response: {body}")
        if ctx is not None:
            ctx.prompt_id = body["prompt_id"]
        if phase_tracker is not None:
            phase_tracker.mark_sent(prompt_id=body["prompt_id"], queue_number=body.get("number"))
        log.event(
            event="prompt.queue.ok",
            ctx=ctx,
            elapsed_ms=int((time.monotonic() - t0) * 1000),
            data={"prompt_id": body.get("prompt_id")},
        )
        return body
    except ComfyPromptError:
        raise
    except Exception as e:
        log.event(
            event="prompt.queue.error",
            level="error",
            ctx=ctx,
            elapsed_ms=int((time.monotonic() - t0) * 1000),
            data={"error": str(e), "error_type": type(e).__name__},
        )
        raise


def fetch_history_entry(
    base_url: str,
    prompt_id: str,
    *,
    timeout: int = 120,
    logger: ComfyLogger | None = None,
    ctx: ComfyJobContext | None = None,
) -> dict[str, Any] | None:
    """GET /history/{prompt_id}; returns entry dict or None if not yet available."""
    log = logger or NullComfyLogger()
    t0 = time.monotonic()
    base = base_url.rstrip("/")
    try:
        r = requests.get(f"{base}/history/{prompt_id}", timeout=timeout)
        r.raise_for_status()
        data = r.json()
        entry = None if (not data or prompt_id not in data) else data[prompt_id]
        if _detail_is_debug() or entry is not None:
            log.event(
                event="history.fetch.ok",
                level="debug",
                ctx=ctx,
                elapsed_ms=int((time.monotonic() - t0) * 1000),
                data={"prompt_id": prompt_id, "found": entry is not None},
            )
        return entry
    except Exception as e:
        log.event(
            event="history.fetch.error",
            level="error",
            ctx=ctx,
            elapsed_ms=int((time.monotonic() - t0) * 1000),
            data={"prompt_id": prompt_id, "error": str(e), "error_type": type(e).__name__},
        )
        raise


def fetch_job_status(
    base_url: str,
    prompt_id: str,
    *,
    timeout: int = 120,
    logger: ComfyLogger | None = None,
    ctx: ComfyJobContext | None = None,
) -> dict[str, Any] | None:
    """GET /api/jobs/{prompt_id}; returns normalized job status or None."""
    log = logger or NullComfyLogger()
    base = base_url.rstrip("/")
    t0 = time.monotonic()
    try:
        r = requests.get(f"{base}/api/jobs/{prompt_id}", timeout=timeout)
        if r.status_code == 404:
            if _detail_is_debug():
                log.event(
                    event="jobs.fetch.ok",
                    level="debug",
                    ctx=ctx,
                    elapsed_ms=int((time.monotonic() - t0) * 1000),
                    data={"prompt_id": prompt_id, "found": False},
                )
            return None
        r.raise_for_status()
        body = r.json()
        log.event(
            event="jobs.fetch.ok",
            level="debug",
            ctx=ctx,
            elapsed_ms=int((time.monotonic() - t0) * 1000),
            data={"prompt_id": prompt_id, "status": body.get("status")},
        )
        return body
    except Exception as e:
        if _detail_is_debug():
            log.event(
                event="jobs.fetch.error",
                level="debug",
                ctx=ctx,
                elapsed_ms=int((time.monotonic() - t0) * 1000),
                data={"prompt_id": prompt_id, "error": str(e), "error_type": type(e).__name__},
            )
        return None


def wait_for_history_entry(
    base_url: str,
    prompt_id: str,
    *,
    timeout_sec: float = 600.0,
    poll_interval_sec: float = 0.5,
    logger: ComfyLogger | None = None,
    ctx: ComfyJobContext | None = None,
    phase_tracker: ComfyPhaseTracker | None = None,
) -> dict[str, Any]:
    """Poll until history contains ``prompt_id`` or timeout."""
    log = logger or NullComfyLogger()
    start = time.monotonic()
    deadline = time.monotonic() + timeout_sec
    polls = 0
    ws_listener: _ComfyWsLifecycleListener | None = None
    if phase_tracker is not None and ctx is not None and ctx.prompt_id:
        ws_listener = _ComfyWsLifecycleListener(
            base_url=base_url,
            client_id=ctx.job_id,
            prompt_id=ctx.prompt_id,
            tracker=phase_tracker,
            logger=log,
            ctx=ctx,
        )
        ws_listener.start()
    log.event(
        event="history.poll.start",
        ctx=ctx,
        data={"prompt_id": prompt_id, "timeout_sec": timeout_sec, "poll_interval_sec": poll_interval_sec},
    )
    while time.monotonic() < deadline:
        polls += 1
        if phase_tracker is not None and polls % 2 == 0:
            job = fetch_job_status(base_url, prompt_id, logger=log, ctx=ctx)
            if job is not None:
                status = str(job.get("status") or "").lower()
                if status == "in_progress":
                    phase_tracker.mark_running(source="jobs_api")
                elif status == "completed":
                    phase_tracker.mark_returned(
                        result="success",
                        source="jobs_api",
                        outputs_count=job.get("outputs_count"),
                    )
                elif status == "failed":
                    err = job.get("execution_error") or {}
                    phase_tracker.mark_returned(
                        result="failed",
                        source="jobs_api",
                        outputs_count=job.get("outputs_count"),
                        error=str(err.get("exception_message") or ""),
                        error_type=str(err.get("exception_type") or ""),
                    )
                elif status == "cancelled":
                    phase_tracker.mark_returned(
                        result="cancelled",
                        source="jobs_api",
                        outputs_count=job.get("outputs_count"),
                    )
        entry = fetch_history_entry(base_url, prompt_id, logger=log, ctx=ctx)
        if entry is not None:
            if phase_tracker is not None:
                status = ((entry.get("status") or {}).get("status_str") or "").lower()
                if status == "success":
                    phase_tracker.mark_returned(result="success", source="history")
                elif status == "error":
                    phase_tracker.mark_returned(result="failed", source="history")
            log.event(
                event="history.poll.ok",
                ctx=ctx,
                elapsed_ms=int((time.monotonic() - start) * 1000),
                data={"prompt_id": prompt_id, "polls": polls},
            )
            if ws_listener is not None:
                ws_listener.stop()
            return entry
        if polls % 10 == 0:
            elapsed = time.monotonic() - start
            log.event(
                event="history.poll.tick",
                level="debug",
                ctx=ctx,
                elapsed_ms=int(elapsed * 1000),
                data={"prompt_id": prompt_id, "polls": polls, "remaining_sec": max(0.0, timeout_sec - elapsed)},
            )
        time.sleep(poll_interval_sec)
    log.event(
        event="history.poll.timeout",
        level="error",
        ctx=ctx,
        elapsed_ms=int((time.monotonic() - start) * 1000),
        data={"prompt_id": prompt_id, "polls": polls, "timeout_sec": timeout_sec},
    )
    if ws_listener is not None:
        ws_listener.stop()
    if phase_tracker is not None:
        phase_tracker.mark_returned(result="failed", source="history_timeout", error="timeout", error_type="TimeoutError")
    raise TimeoutError(
        f"Timed out after {timeout_sec}s waiting for history for prompt_id={prompt_id}"
    )


def view_image_bytes(
    base_url: str,
    filename: str,
    subfolder: str,
    folder_type: str,
    *,
    timeout: int = 120,
    logger: ComfyLogger | None = None,
    ctx: ComfyJobContext | None = None,
) -> bytes:
    """GET /view for an output/input image."""
    log = logger or NullComfyLogger()
    t0 = time.monotonic()
    base = base_url.rstrip("/")
    q = urlencode(
        {
            "filename": filename,
            "subfolder": subfolder,
            "type": folder_type,
        }
    )
    log.event(
        event="image.view.start",
        level="debug",
        ctx=ctx,
        data={"filename": filename, "subfolder": subfolder, "type": folder_type, "timeout": timeout},
    )
    try:
        r = requests.get(f"{base}/view?{q}", timeout=timeout)
        r.raise_for_status()
        data = r.content
        log.event(
            event="image.view.ok",
            level="debug",
            ctx=ctx,
            elapsed_ms=int((time.monotonic() - t0) * 1000),
            data={"filename": filename, "bytes": len(data)},
        )
        return data
    except Exception as e:
        log.event(
            event="image.view.error",
            level="error",
            ctx=ctx,
            elapsed_ms=int((time.monotonic() - t0) * 1000),
            data={"filename": filename, "error": str(e), "error_type": type(e).__name__},
        )
        raise
