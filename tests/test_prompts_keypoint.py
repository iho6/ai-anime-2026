"""Tests for pose/expression generation prompt composition."""

from __future__ import annotations

from services.prompts import (
    compose_expression_generation_prompt,
    compose_keypoint_pose_edit_prompt,
    compose_pose_generation_prompt,
    normalize_expression_user_description,
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


def test_normalize_expression_user_description_strips_catalog_wrap() -> None:
    wrapped = "Edit the face to show a warm smile, keep identity coherent."
    assert normalize_expression_user_description(wrapped) == "a warm smile"
    assert normalize_expression_user_description("frowning") == "frowning"
    assert normalize_expression_user_description("") == ""


def test_compose_keypoint_pose_edit_prompt_pose_first() -> None:
    p = compose_keypoint_pose_edit_prompt("", with_closeup_sheet=False)
    assert "Draw the character from Picture 1" in p
    assert "Picture 2" in p
    assert "plain white background" in p
    assert "Exactly one character" in p


def test_compose_keypoint_pose_edit_prompt_user_text_appended() -> None:
    p = compose_keypoint_pose_edit_prompt("jogging", with_closeup_sheet=False)
    assert "jogging." in p
    assert p.index("Picture 2") < p.index("jogging")


def test_compose_keypoint_pose_edit_prompt_normalizes_wrapped_user_text() -> None:
    wrapped = (
        "Edit the subject to running fast, keep identity and clothing coherent unless impossible."
    )
    p = compose_keypoint_pose_edit_prompt(wrapped, with_closeup_sheet=False)
    assert "running fast." in p
    assert "Edit the subject to" not in p


def test_compose_keypoint_pose_edit_prompt_with_closeup() -> None:
    p = compose_keypoint_pose_edit_prompt("jogging", with_closeup_sheet=True)
    assert "Picture 1" in p
    assert "Picture 2" in p
    assert "Picture 3" in p
    assert "jogging" in p


def test_compose_pose_generation_prompt_text_only_raw() -> None:
    p = compose_pose_generation_prompt(
        "hands out of pocket", has_keypoint=False, with_closeup_sheet=False
    )
    assert p == (
        "Edit the subject to hands out of pocket, "
        "keep identity and clothing coherent unless impossible."
    )


def test_compose_pose_generation_prompt_text_only_idempotent() -> None:
    wrapped = (
        "Edit the subject to hands out of pocket, "
        "keep identity and clothing coherent unless impossible."
    )
    p = compose_pose_generation_prompt(wrapped, has_keypoint=False, with_closeup_sheet=False)
    assert "hands out of pocket" in p
    assert p.count("Edit the subject to") == 1


def test_compose_pose_generation_prompt_keypoint_only() -> None:
    p = compose_pose_generation_prompt("", has_keypoint=True, with_closeup_sheet=False)
    assert "Picture 2" in p
    assert "Draw the character from Picture 1" in p


def test_compose_pose_generation_prompt_keypoint_with_user_text() -> None:
    p = compose_pose_generation_prompt(
        "jogging", has_keypoint=True, with_closeup_sheet=False
    )
    assert "jogging." in p
    assert "Picture 2" in p


def test_compose_expression_generation_prompt_raw() -> None:
    p = compose_expression_generation_prompt("warm smile")
    assert p == "Edit the face to show warm smile, keep identity coherent."


def test_compose_expression_generation_prompt_idempotent() -> None:
    wrapped = "Edit the face to show warm smile, keep identity coherent."
    p = compose_expression_generation_prompt(wrapped)
    assert p == wrapped
