"""
Reusable structured logging helpers for Comfy call-type jobs.

Stable minimal phase events (info-level by default):
- ``job.sent``: request accepted by Comfy queue (has ``prompt_id``).
- ``job.running``: first runtime execution signal detected.
- ``job.returned``: terminal state reached (``result`` in success/failed/cancelled).
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO


def _ts_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


@dataclass
class ComfyJobContext:
    job_id: str
    service: str
    workflow: str
    comfy_url: str
    request_id: str | None = None
    prompt_id: str | None = None


@dataclass
class ComfyEvent:
    event: str
    level: str
    ts: str
    job_id: str | None = None
    service: str | None = None
    workflow: str | None = None
    prompt_id: str | None = None
    comfy_url: str | None = None
    elapsed_ms: int | None = None
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ComfyLogger:
    def emit(self, event: ComfyEvent) -> None:
        raise NotImplementedError

    def event(
        self,
        *,
        event: str,
        level: str = "info",
        ctx: ComfyJobContext | None = None,
        elapsed_ms: int | None = None,
        data: dict[str, Any] | None = None,
    ) -> None:
        e = ComfyEvent(
            event=event,
            level=level,
            ts=_ts_now(),
            job_id=ctx.job_id if ctx else None,
            service=ctx.service if ctx else None,
            workflow=ctx.workflow if ctx else None,
            prompt_id=ctx.prompt_id if ctx else None,
            comfy_url=ctx.comfy_url if ctx else None,
            elapsed_ms=elapsed_ms,
            data=data or {},
        )
        self.emit(e)


class NullComfyLogger(ComfyLogger):
    def emit(self, event: ComfyEvent) -> None:
        return None


class StdoutComfyLogger(ComfyLogger):
    def __init__(self, stream: TextIO | None = None):
        self.stream = stream or sys.stdout

    def emit(self, event: ComfyEvent) -> None:
        detail = os.environ.get("COMFY_LOG_DETAIL", "").strip().lower()
        if event.level == "debug" and detail not in {"1", "true", "yes", "debug"}:
            return
        parts = [f"[comfy][{event.level}]", event.event]
        if event.job_id:
            parts.append(f"job={event.job_id}")
        if event.prompt_id:
            parts.append(f"prompt={event.prompt_id}")
        if event.elapsed_ms is not None:
            parts.append(f"elapsed_ms={event.elapsed_ms}")
        if event.data:
            parts.append(f"data={json.dumps(event.data, ensure_ascii=True, sort_keys=True)}")
        self.stream.write(" ".join(parts) + "\n")
        self.stream.flush()


class JsonlComfyLogger(ComfyLogger):
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, event: ComfyEvent) -> None:
        detail = os.environ.get("COMFY_LOG_DETAIL", "").strip().lower()
        if event.level == "debug" and detail not in {"1", "true", "yes", "debug"}:
            return
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(event.to_dict(), ensure_ascii=True) + "\n")


def build_comfy_logger() -> ComfyLogger:
    fmt = os.environ.get("COMFY_LOG_FORMAT", "text").strip().lower()
    if fmt in ("none", "off", "null", "0"):
        return NullComfyLogger()
    if fmt == "json":
        path = os.environ.get("COMFY_LOG_PATH", "logs/comfy_calls.jsonl")
        return JsonlComfyLogger(Path(path))
    return StdoutComfyLogger()
