"""
Positive prompt text for the new-character base draft (Anima / image_anima_preview).

Used with ``skip_default_style_prefix`` on the anime image service so this string is
the full node-11 positive (the service does not prepend DEFAULT_STYLE_PREFIX again).
"""

from __future__ import annotations

# Mirrors former anime_img_gen DEFAULT_STYLE_PREFIX for this flow only, plus solo
# constraints and pose. Keep in sync intentionally if you change global Anima style.
_NEW_CHARACTER_POSITIVE_LEAD = (
    "masterpiece, best quality, score_7, safe. anime, plain white background, full body view, "
    "only one character, solo, no additional people, no crowd, no duplicate characters, "
    "a single full frontal view of the character, standing straight, facing the camera, "
    "arms relaxed at both sides"
)


def compose_new_character_positive_prompt(user_description: str) -> str:
    """
    Build the full positive prompt for a new-character base image.

    ``user_description`` is the subject the user typed (appearance, outfit, etc.).
    """
    u = (user_description or "").strip()
    if not u:
        return _NEW_CHARACTER_POSITIVE_LEAD
    return f"{_NEW_CHARACTER_POSITIVE_LEAD}, {u}"
