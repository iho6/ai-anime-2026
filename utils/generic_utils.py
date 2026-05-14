"""Generic shared helpers.

This module intentionally stays small and dependency-light so it can be imported
from both runtime code (`code/`) and CLI scripts (`scripts/`).
"""

from __future__ import annotations

import contextlib
import re
import sys
import time

_SAFE_FILENAME_EMPTY = "safe_filename error: input text must be non-empty."


def safe_filename_component(text: str) -> str:
    """
    Normalize arbitrary user text into a safe single-path-component string.

    Rules mirror existing call sites:
    - strip whitespace; error if empty
    - replace slashes with underscores
    - collapse whitespace to underscores
    - remove everything except A-Za-z0-9._-
    - if cleanup removes all characters, fall back to 'character'
    """
    s = (text or "").strip()
    if not s:
        raise ValueError(_SAFE_FILENAME_EMPTY)
    s = s.replace("\\", "_").replace("/", "_")
    s = re.sub(r"\s+", "_", s)
    s = re.sub(r"[^A-Za-z0-9._-]", "", s)
    return s or "character"


def eprint(msg: str) -> None:
    """Print to stderr (flush) for CLI-style logs."""
    print(str(msg), file=sys.stderr, flush=True)


@contextlib.contextmanager
def section(title: str):
    """Emit a titled `=== ... ===` section with timing.

    Intended for CLI entrypoints to produce readable logs with clear boundaries.
    """
    start = time.monotonic()
    eprint(f"\n=== {title} ===")
    try:
        yield
    except Exception as exc:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        eprint(f"=== fail: {title} elapsed_ms={elapsed_ms} error={type(exc).__name__}: {exc} ===")
        raise
    else:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        eprint(f"=== ok: {title} elapsed_ms={elapsed_ms} ===")

