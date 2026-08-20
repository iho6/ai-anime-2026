"""One-shot kimodo + MotionCorrection install (Windows-friendly CLI).

Usage (repo root, after .venv exists)::

    .venv\\Scripts\\python.exe utils\\install_kimodo.py
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    os.environ["ANIME2026_FORCE_KIMODO_BUILD"] = "1"
    os.environ.pop("ANIME2026_SKIP_KIMODO", None)

    from services.kimodo_setup import (
        ensure_kimodo_installed,
        kimodo_importable,
        motion_correction_extension_files,
    )

    def run_command(cmd, *, cwd=None, log_cb=None, env=None):
        if log_cb:
            log_cb("$ " + " ".join(str(c) for c in cmd))
        proc = subprocess.run(
            [str(c) for c in cmd],
            cwd=str(cwd) if cwd else None,
            env=env or os.environ.copy(),
        )
        if proc.returncode != 0:
            raise RuntimeError(f"command failed ({proc.returncode}): {cmd}")

    def log(msg: str) -> None:
        print(msg, flush=True)

    ensure_kimodo_installed(run_command=run_command, log_cb=log)
    if not kimodo_importable():
        print("kimodo / motion_correction still not importable after install", file=sys.stderr)
        return 1
    ext = motion_correction_extension_files()
    print(
        "extension files:",
        ", ".join(p.name for p in ext) if ext else "(none)",
        flush=True,
    )
    if not any(p.suffix.lower() in {".pyd", ".so", ".dll"} for p in ext):
        print(
            "no _motion_correction*.pyd/.so found under MotionCorrection",
            file=sys.stderr,
        )
        return 1
    print("OK: kimodo + motion_correction importable", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
