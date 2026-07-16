"""Reference library T2I prompt composition (Qwen, photorealistic)."""

from services.prompts import (
    REFERENCE_IMAGE_POSITIVE_LEAD,
    compose_new_character_positive_prompt,
    compose_reference_base_t2i_prompt,
)


def test_reference_prompt_is_photorealistic_not_anime() -> None:
    full = compose_reference_base_t2i_prompt("woman in a red dress, arms raised")
    assert "photorealistic" in full
    assert "score_7" not in full
    assert ". anime," not in full
    assert "woman in a red dress, arms raised" in full


def test_reference_prompt_has_no_fixed_pose_constraints() -> None:
    lead = REFERENCE_IMAGE_POSITIVE_LEAD.lower()
    for forbidden in (
        "standing straight",
        "facing the camera",
        "arms relaxed",
        "full frontal",
    ):
        assert forbidden not in lead


def test_reference_prompt_empty_user_returns_lead_only() -> None:
    assert compose_reference_base_t2i_prompt("") == REFERENCE_IMAGE_POSITIVE_LEAD
    assert compose_reference_base_t2i_prompt("   ") == REFERENCE_IMAGE_POSITIVE_LEAD


def test_new_character_prompt_unchanged_anime_style() -> None:
    full = compose_new_character_positive_prompt("blue hair mage")
    assert "anime" in full
    assert "standing straight" in full
    assert "blue hair mage" in full
