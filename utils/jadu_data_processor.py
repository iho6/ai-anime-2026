"""Jadu QC results data processor.

Loads and parses entries from Jadu QC results JSON files into a normalized
structure ready for batch gen eval.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _parse_jadu_qa(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "score": entry.get("qaScore"),
        "transformed_score": entry.get("qaTransformedScore"),
        "reasoning": entry.get("qaReasoning"),
        "actionable_feedback": entry.get("qaActionableFeedback"),
    }


def parse_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    """Parse a single Jadu QC entry into a normalized eval-ready dict.

    Returns None if the entry has no reference images or no output (not evaluable).
    """
    refs = [img for img in entry.get("images", []) if img]
    output = entry.get("outputImage") or entry.get("outputVideo")
    if not refs or not output:
        return None
    return {
        "job_id": entry.get("jobId", ""),
        "prompt": entry.get("prompt", ""),
        "refs": refs,
        "output": output,
        "jadu_qa": _parse_jadu_qa(entry),
    }


def load_entries(
    path: str | Path,
    *,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Load and parse evaluable entries from a Jadu QC results JSON file.

    Skips entries with no reference images or no output. Applies limit to the
    first N evaluable entries, not the first N raw entries.
    """
    raw: list[dict[str, Any]] = json.loads(Path(path).read_text(encoding="utf-8"))
    parsed: list[dict[str, Any]] = []
    for entry in raw:
        result = parse_entry(entry)
        if result is not None:
            parsed.append(result)
            if limit is not None and len(parsed) >= limit:
                break
    return parsed
