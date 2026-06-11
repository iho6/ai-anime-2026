"""SAM3 optional text prompt validation and workflow patching."""

from __future__ import annotations

import json

import pytest

from services.logic import _sam3_coords_json, _validate_sam3_segment_input
from services.sam3_segment_ai_service.serverless import (
    _patch_image_workflow,
    _patch_sam3_text,
    _prompt_from_task,
    _validate_sam3_prompts,
    workflows,
)


def test_validate_empty_points_and_text_raises() -> None:
    with pytest.raises(ValueError, match="positive point or a text prompt"):
        _validate_sam3_prompts([], "")
    with pytest.raises(ValueError, match="positive point or a text prompt"):
        _validate_sam3_segment_input([], None)


def test_validate_text_only_passes() -> None:
    _validate_sam3_prompts([], "person")
    assert _validate_sam3_segment_input([], "person") == "person"


def test_validate_points_only_passes() -> None:
    _validate_sam3_prompts([{"x": 1, "y": 2}], "")
    assert _validate_sam3_segment_input([{"x": 1, "y": 2}], None) == ""


def test_coords_json_text_only_returns_empty_array() -> None:
    pos_json, neg_json = _sam3_coords_json([], [])
    assert json.loads(pos_json) == []
    assert json.loads(neg_json) == []


def test_patch_sam3_text_sets_clip_encode() -> None:
    wf = {
        "1": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["2", 1], "text": ""},
        }
    }
    _patch_sam3_text(wf, "red car")
    assert wf["1"]["inputs"]["text"] == "red car"


def test_prompt_from_task_text_prompt_camel_case() -> None:
    pos_json, neg_json, text = _prompt_from_task(
        {"positiveCoords": [], "negativeCoords": [], "textPrompt": "dog"}
    )
    assert json.loads(pos_json) == []
    assert json.loads(neg_json) == []
    assert text == "dog"


def test_prompt_from_task_text_prompt_snake_case() -> None:
    _pos, _neg, text = _prompt_from_task(
        {"positive_coords": [{"x": 10, "y": 20}], "text_prompt": "cat"}
    )
    assert text == "cat"


def test_patch_image_workflow_keeps_sam3_conditioning_link() -> None:
    api = workflows.get("sam3_image_mask_api")
    assert api is not None
    patched = _patch_image_workflow(
        api,
        image_input_ref="test.png",
        positive_coords="[]",
        negative_coords="[]",
        text_prompt="person",
    )
    detect = next(
        n for n in patched.values() if n.get("class_type") == "SAM3_Detect"
    )
    assert detect["inputs"].get("conditioning") is not None
    clip = next(
        n for n in patched.values() if n.get("class_type") == "CLIPTextEncode"
    )
    assert clip["inputs"]["text"] == "person"
