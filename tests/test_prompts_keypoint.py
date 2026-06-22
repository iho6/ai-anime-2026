"""Tests for keypoint pose edit prompt composition."""

from __future__ import annotations

from services.prompts import (
    compose_keypoint_pose_edit_prompt,
    normalize_keypoint_user_description,
)


def test_normalize_keypoint_user_description_strips_catalog_wrap() -> None:
    wrapped = (
        "Edit the subject to standing with hands on hips, "
        "keep identity and clothing coherent unless impossible."
    )
    assert normalize_keypoint_user_description(wrapped) == "standing with hands on hips"
    assert normalize_keypoint_user_description("jogging") == "jogging"
    assert normalize_keypoint_user_description("") == ""


def test_compose_keypoint_pose_edit_prompt_pose_first() -> None:
    p = compose_keypoint_pose_edit_prompt("", with_closeup_sheet=False)
    pose_idx = p.index("primary authority for body pose")
    solo_idx = p.index("only one character")
    assert pose_idx < solo_idx
    assert "Replace the scene" not in p
    assert "Return a single full-body image" in p
    assert "primary authority for body pose" in p
    assert "plain white background" in p
    assert "no text" in p
    assert "#ffffff" not in p.lower()
    assert "ffffff" not in p


def test_compose_keypoint_pose_edit_prompt_user_text_appended() -> None:
    p = compose_keypoint_pose_edit_prompt("jogging", with_closeup_sheet=False)
    assert p.index("primary authority for body pose") < p.index("jogging")
    assert p.endswith("Optional action or mood: jogging.")


def test_compose_keypoint_pose_edit_prompt_normalizes_wrapped_user_text() -> None:
    wrapped = (
        "Edit the subject to running fast, keep identity and clothing coherent unless impossible."
    )
    p = compose_keypoint_pose_edit_prompt(wrapped, with_closeup_sheet=False)
    assert "Optional action or mood: running fast." in p
    assert "Edit the subject to" not in p


def test_compose_keypoint_pose_edit_prompt_with_closeup() -> None:
    p = compose_keypoint_pose_edit_prompt("jogging", with_closeup_sheet=True)
    assert "closeup auxiliary only for facial identity" in p
    assert "Return only the full-body image, no close-up inset" in p
    assert "jogging" in p
    assert p.index("primary authority for body pose") < p.index("only one character")
