"""CLI-oriented exception formatting (stdlib only; no third-party deps)."""

from __future__ import annotations

import sys
import traceback
from typing import TextIO

# Cap JSONL payload size when embedding tracebacks in structured logs.
_DEFAULT_TRACEBACK_LOG_CAP = 64 * 1024


def format_exception_chain(exc: BaseException, *, max_len: int | None = None) -> str:
    """Return a string for a full exception chain (``from exc`` / context), optional truncation."""
    text = "".join(traceback.format_exception(exc, chain=True))
    cap = max_len if max_len is not None else None
    if cap is not None and len(text) > cap:
        text = text[: cap - 24] + "\n... [truncated]\n"
    return text


def format_exception_chain_for_log(exc: BaseException) -> str:
    """Format like :func:`format_exception_chain` with default cap for JSON / log fields."""
    return format_exception_chain(exc, max_len=_DEFAULT_TRACEBACK_LOG_CAP)


def print_cli_error(exc: BaseException, *, file: TextIO | None = None) -> None:
    """Print ``error: …`` then the full traceback chain to stderr (or ``file``)."""
    out = file if file is not None else sys.stderr
    print(f"error: {exc}", file=out)
    for line in traceback.format_exception(exc, chain=True):
        out.write(line)
