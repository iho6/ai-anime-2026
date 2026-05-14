"""VLM helper utilities (Yes/No checks, parsing, media type detection, etc.)."""

from __future__ import annotations

import re
import requests
from pathlib import Path
from typing import Any

from qwen_vl import QwenVL
from utils.generic_utils import eprint

_VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}


def detect_output_type(path: str) -> str:
    """Return 'video' or 'image' based on extension, with HTTP HEAD fallback for extensionless URLs."""
    suffix = Path(path).suffix.lower()
    if suffix in _VIDEO_EXTS:
        return "video"
    if suffix:
        return "image"
    if path.startswith("http://") or path.startswith("https://"):
        try:
            r = requests.head(path, allow_redirects=True, timeout=5)
            ct = r.headers.get("Content-Type", "")
            if ct.startswith("video/"):
                return "video"
        except Exception:
            pass
    return "image"


def extract_assistant_text(raw: object) -> str:
    """Extract assistant response from a decoded chat transcript.

    If the output includes an `assistant` marker (common when decoding prompt+response),
    return the content after the last assistant marker. Otherwise return the raw text.
    """
    s = str(raw)
    lines = s.splitlines()
    last_idx: int | None = None
    inline_content: str | None = None

    for i, line in enumerate(lines):
        stripped = line.strip()
        lowered = stripped.lower()
        if lowered == "assistant":
            last_idx = i
            inline_content = None
        elif lowered.startswith("assistant:"):
            last_idx = i
            inline_content = stripped.split(":", 1)[1].strip()
        elif lowered.startswith("assistant -"):
            last_idx = i
            inline_content = stripped.split("-", 1)[1].strip()

    if last_idx is None:
        return s
    if inline_content:
        return inline_content
    return "\n".join(lines[last_idx + 1 :]).strip()


def extract_yes_no(raw: object) -> str:
    """Extract a single-word Yes/No from a model output.

    Works with raw outputs that include the prompt transcript and/or reasoning,
    as long as the final answer includes a standalone Yes/No.
    """
    assistant = extract_assistant_text(raw)
    # Prefer the final non-empty line.
    for line in reversed(assistant.splitlines()):
        s = line.strip()
        if not s:
            continue
        lowered = s.lower()
        if lowered in ("yes", "no"):
            return lowered
        break
    lowered = assistant.strip().lower()
    if lowered in ("yes", "no"):
        return lowered
    for line in reversed(assistant.splitlines()):
        token = line.strip().strip(".!?,:;\"'“”‘’").lower()
        if token in ("yes", "no"):
            return token
    return lowered


def character_fullbody_check(*, runner: QwenVL, image_source: str, prompt: str) -> bool:
    """Return True if full-body, False if not, based on strict VLM Yes/No output."""
    raw = runner.vl_eval([image_source], prompt)
    assistant_text = extract_assistant_text(raw).strip()
    text = extract_yes_no(raw)

    _MAX = 320
    shown = assistant_text
    truncated = False
    if len(shown) > _MAX:
        shown = shown[:_MAX] + "..."
        truncated = True
    eprint(
        "full_body_check_assistant_text="
        + repr(shown)
        + (" (truncated)" if truncated else "")
        + " full_body_check_decision="
        + str(text)
    )
    if text == "yes":
        return True
    if text == "no":
        return False
    raise ValueError(f"Full-body check must return 'Yes' or 'No'. Got: {raw!r}")


def parse_yes_no_eval_output(text: str) -> dict[str, Any]:
    """Extract response (bool | None) and reasoning (str) from a Yes/No VLM eval response."""
    response: bool | None = None
    reasoning = ""
    for line in text.splitlines():
        s = line.strip()
        if s.lower().startswith("response:"):
            response = s.split(":", 1)[1].strip().lower().startswith("yes")
        elif s.lower().startswith("reasoning:"):
            reasoning = s.split(":", 1)[1].strip()
    return {"response": response, "reasoning": reasoning}


def parse_out_of_5_eval_output(text: str) -> dict[str, Any]:
    """Extract score (int 0-5 | None) and reasoning (str) from a scored VLM eval response."""
    score: int | None = None
    reasoning = ""
    for line in text.splitlines():
        s = line.strip()
        if s.lower().startswith("response:"):
            m = re.match(r"(\d)/5", s.split(":", 1)[1].strip())
            if m:
                score = int(m.group(1))
        elif s.lower().startswith("reasoning:"):
            reasoning = s.split(":", 1)[1].strip()
    return {"score": score, "reasoning": reasoning}


def parse_bullet_list(text: str) -> list[str]:
    """Extract bullet-point items from a VLM response into a plain list of strings."""
    items = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("- "):
            items.append(s[2:].strip())
        elif s.startswith("* "):
            items.append(s[2:].strip())
    return items


def parse_artifact_eval(text: str, item: str) -> dict[str, Any]:
    """Parse a single artifact evaluation block from a VLM response.

    Expects two lines:
        Response: True/False
        Reasoning: <reasoning>

    The artifact description is taken directly from the input `item` to avoid
    parser failures caused by model output format variation.

    Returns {"artifact": str, "desired": bool | None, "reasoning": str}.
    desired=None means the response could not be parsed.
    """
    assistant = extract_assistant_text(text)
    desired: bool | None = None
    reasoning = ""
    for line in assistant.splitlines():
        s = line.strip()
        lower = s.lower()
        if lower.startswith("response:"):
            val = s.split(":", 1)[1].strip().lower()
            desired = val.startswith("true")
        elif lower.startswith("reasoning:"):
            reasoning = s.split(":", 1)[1].strip()
    return {"artifact": item, "desired": desired, "reasoning": reasoning}

