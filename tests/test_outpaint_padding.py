"""Tests for outpaint padding snap and input normalization."""

from __future__ import annotations

import pytest

from services.outpaint_ai_service.serverless import normalize_outpaint_inputs, snap_outpaint_padding
from services.outpaint_padding import (
    DEFAULT_MAX_OUTPAINT_PER_PASS,
    split_outpaint_into_stages,
)


def test_split_outpaint_single_stage():
    stages = split_outpaint_into_stages(
        {"left": 0, "top": 0, "right": 256, "bottom": 0},
        max_per_pass=512,
    )
    assert stages == [{"left": 0, "top": 0, "right": 256, "bottom": 0}]


def test_split_outpaint_two_stages_right_only():
    stages = split_outpaint_into_stages(
        {"left": 0, "top": 0, "right": 800, "bottom": 0},
        max_per_pass=512,
    )
    assert len(stages) == 2
    assert stages[0]["right"] == 512
    assert stages[1]["right"] == 288
    assert sum(s["right"] for s in stages) == 800


def test_split_outpaint_multi_side_parallel():
    stages = split_outpaint_into_stages(
        {"left": 0, "top": 0, "right": 600, "bottom": 600},
        max_per_pass=512,
    )
    assert len(stages) == 2
    assert stages[0] == {"left": 0, "top": 0, "right": 512, "bottom": 512}
    assert stages[1] == {"left": 0, "top": 0, "right": 88, "bottom": 88}


def test_split_outpaint_respects_custom_max_per_pass():
    stages = split_outpaint_into_stages(
        {"left": 0, "top": 0, "right": 384, "bottom": 0},
        max_per_pass=256,
    )
    assert stages == [
        {"left": 0, "top": 0, "right": 256, "bottom": 0},
        {"left": 0, "top": 0, "right": 128, "bottom": 0},
    ]


def test_default_max_outpaint_per_pass_is_half_native_dim():
    assert DEFAULT_MAX_OUTPAINT_PER_PASS == 512


def test_snap_outpaint_padding_zero():
    assert snap_outpaint_padding(0) == 0


def test_snap_outpaint_padding_rounds_to_eight():
    assert snap_outpaint_padding(1) == 8
    assert snap_outpaint_padding(7) == 8
    assert snap_outpaint_padding(8) == 8
    assert snap_outpaint_padding(9) == 8
    assert snap_outpaint_padding(12) == 16
    assert snap_outpaint_padding(100) == 96


def test_normalize_outpaint_inputs_snaps_padding():
    out = normalize_outpaint_inputs(
        {
            "image_url": "http://example.com/a.png",
            "left": 10,
            "top": 0,
            "right": 0,
            "bottom": 256,
        }
    )
    assert out["left"] == 8
    assert out["top"] == 0
    assert out["right"] == 0
    assert out["bottom"] == 256
    assert out["feathering"] == 40
    assert out["steps"] == 8


def test_normalize_outpaint_inputs_requires_padding():
    with pytest.raises(ValueError, match="At least one padding"):
        normalize_outpaint_inputs({"image_url": "http://example.com/a.png"})


def test_normalize_outpaint_inputs_requires_image_url():
    with pytest.raises(ValueError, match="image_url"):
        normalize_outpaint_inputs({"left": 64})
