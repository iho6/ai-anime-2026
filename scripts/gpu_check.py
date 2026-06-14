#!/usr/bin/env python3
"""CLI wrapper around services.utils.gpu_preflight for manual GPU diagnostics."""

from __future__ import annotations

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))


def main() -> int:
    from services.utils import gpu_preflight

    lines: list[str] = []

    def log_cb(msg: str) -> None:
        lines.append(msg)
        print(msg)

    err, detail = gpu_preflight(log_cb=log_cb)
    if err:
        print(f"ERROR: {err}", file=sys.stderr)
        return 1
    if detail:
        print(f"OK: {detail}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
