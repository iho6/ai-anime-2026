"""Run blocking logic with log_cb on a thread; stream lines to a WebSocket."""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Callable
from typing import Any, TypeVar

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect
from uvicorn.protocols.utils import ClientDisconnected

T = TypeVar("T")

_HEARTBEAT_SEC = 18.0
_DONE = "__DONE__"


async def safe_send_json(ws: WebSocket, payload: dict[str, Any]) -> bool:
    """
    Send JSON if the socket is still usable; return False after disconnect / close.
    """
    try:
        await ws.send_json(payload)
        return True
    except WebSocketDisconnect:
        return False
    except ClientDisconnected:
        return False
    except RuntimeError as e:
        if "close message has been sent" in str(e).lower():
            return False
        raise


async def _drain_queue_until_done(q: asyncio.Queue[str | object]) -> None:
    while True:
        item = await q.get()
        if item == _DONE:
            break


async def run_with_log_stream(
    ws: WebSocket,
    work: Callable[[Callable[[str], None]], T],
) -> tuple[T | None, str | None]:
    """
    Execute ``work(log_cb)`` in a daemon thread. Send {"type":"log","line":...} for each line.
    Periodically sends heartbeats so long GPU-bound stretches do not look idle on proxies.
    Returns (result, error_message). On success error_message is None.
    """
    loop = asyncio.get_running_loop()
    q: asyncio.Queue[str | object] = asyncio.Queue()
    result_holder: list[Any] = [None]
    err_holder: list[str | None] = [None]

    def log_cb(line: str) -> None:
        loop.call_soon_threadsafe(q.put_nowait, line)

    def runner() -> None:
        try:
            result_holder[0] = work(log_cb)
        except Exception as e:
            err_holder[0] = str(e)
        finally:
            loop.call_soon_threadsafe(q.put_nowait, _DONE)

    threading.Thread(target=runner, daemon=True).start()
    while True:
        try:
            item = await asyncio.wait_for(q.get(), timeout=_HEARTBEAT_SEC)
        except asyncio.TimeoutError:
            if not await safe_send_json(
                ws, {"type": "heartbeat", "ts": int(time.time())}
            ):
                await _drain_queue_until_done(q)
                break
            continue
        if item == _DONE:
            break
        if not await safe_send_json(ws, {"type": "log", "line": str(item)}):
            await _drain_queue_until_done(q)
            break
    return result_holder[0], err_holder[0]


async def pump_startup_log_queue(ws: WebSocket, q: asyncio.Queue[str]) -> bool:
    """
    Stream string log lines from ``q`` until the sentinel ``"__DONE__"``.
    Heartbeats apply between lines. Returns False if the client disconnected.
    """
    done = "__DONE__"
    while True:
        try:
            line = await asyncio.wait_for(q.get(), timeout=_HEARTBEAT_SEC)
        except asyncio.TimeoutError:
            if not await safe_send_json(
                ws, {"type": "heartbeat", "ts": int(time.time())}
            ):
                while True:
                    x = await q.get()
                    if x == done:
                        break
                return False
            continue
        if line == done:
            return True
        if not await safe_send_json(ws, {"type": "log", "line": line}):
            while True:
                x = await q.get()
                if x == done:
                    break
            return False
