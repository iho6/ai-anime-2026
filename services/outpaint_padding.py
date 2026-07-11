"""Outpaint padding helpers (mirrors ui/frontend/src/lib/outpaintPadding.ts for tests)."""

from __future__ import annotations

from typing import TypedDict

PAD_STEP = 8
QWEN_NATIVE_OUTPAINT_DIM = 1024
DEFAULT_MAX_OUTPAINT_PER_PASS = 512


class OutpaintPadding(TypedDict):
    left: int
    top: int
    right: int
    bottom: int


def snap_outpaint_padding(value: int, step: int = PAD_STEP) -> int:
    v = max(0, int(round(value)))
    if v == 0:
        return 0
    return max(step, int(round(v / step)) * step)


def has_outpaint_padding(pad: OutpaintPadding) -> bool:
    return pad["left"] > 0 or pad["top"] > 0 or pad["right"] > 0 or pad["bottom"] > 0


def _split_side_into_chunks(total: int, max_per_pass: int) -> list[int]:
    if total <= 0:
        return []
    cap = max(PAD_STEP, snap_outpaint_padding(max_per_pass))
    chunks: list[int] = []
    remaining = total
    while remaining > 0:
        if remaining <= cap:
            chunks.append(remaining)
            break
        chunks.append(cap)
        remaining -= cap
    return chunks


def split_outpaint_into_stages(
    pad: OutpaintPadding,
    max_per_pass: int = DEFAULT_MAX_OUTPAINT_PER_PASS,
) -> list[OutpaintPadding]:
    left_chunks = _split_side_into_chunks(pad["left"], max_per_pass)
    top_chunks = _split_side_into_chunks(pad["top"], max_per_pass)
    right_chunks = _split_side_into_chunks(pad["right"], max_per_pass)
    bottom_chunks = _split_side_into_chunks(pad["bottom"], max_per_pass)
    num_stages = max(
        len(left_chunks),
        len(top_chunks),
        len(right_chunks),
        len(bottom_chunks),
        1,
    )
    stages: list[OutpaintPadding] = []
    for i in range(num_stages):
        stage: OutpaintPadding = {
            "left": left_chunks[i] if i < len(left_chunks) else 0,
            "top": top_chunks[i] if i < len(top_chunks) else 0,
            "right": right_chunks[i] if i < len(right_chunks) else 0,
            "bottom": bottom_chunks[i] if i < len(bottom_chunks) else 0,
        }
        if has_outpaint_padding(stage):
            stages.append(stage)
    return stages if stages else [{"left": 0, "top": 0, "right": 0, "bottom": 0}]
