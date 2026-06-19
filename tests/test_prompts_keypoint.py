"""Tests for keypoint pose edit prompt composition."""

from __future__ import annotations

from services.prompts import compose_keypoint_pose_edit_prompt


def test_compose_keypoint_pose_edit_prompt_solo_and_no_text() -> None:
    p = compose_keypoint_pose_edit_prompt("", with_closeup_sheet=False)
    assert "only one character" in p
    assert "no duplicate" in p
    assert "no text" in p
    assert "typography" in p
    assert "plain white background" in p
    assert "#ffffff" not in p.lower()
    assert "ffffff" not in p
    assert "Replace the scene with exactly one full-body image" in p


def test_compose_keypoint_pose_edit_prompt_with_closeup() -> None:
    p = compose_keypoint_pose_edit_prompt("jogging", with_closeup_sheet=True)
    assert "closeup auxiliary only for facial identity" in p
    assert "exactly one full-body figure" in p
    assert "jogging" in p
    assert "only one character" in p
