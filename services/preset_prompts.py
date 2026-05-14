"""
Preset prompt fragments for pose / image-edit flows.

Keypoint auxiliary images (with optional base_closeup composite) append these hints
via ``services.logic`` helpers.
"""

from __future__ import annotations

POSE_KEYPOINT_CLOSEUP_PROMPT_SUFFIX = (
    "Return a single full body image of the same character as in the first input reference (starting image), "
    "in the same pose as the keypoint skeleton (3rd image)."
    "Return only a the full body image, no close-up reference."
    "Keep facial features consistent."
)

POSE_KEYPOINT_ONLY_ROLE_HINT = (
    "Return a single full body image of the same character as in the first input reference (starting image), "
    "in the same pose as the keypoint image. Return only a the full body image, no close-up reference."
)
