"""
Single source of truth for all model-facing prompt text across anime2026.

Sections below are grouped by the service/feature that consumes them. The four bulk
prompt collections (pose, expression, camera angles, location checklist) live alongside
this module as JSON files; their paths + a loader are exposed here.

IMPORTANT: keep this module dependency-light (stdlib only). It is imported by the
RunPod serverless workers (anime_img_gen, multi_angle, image_edit, outpaint), so it must
NOT import ``services.logic`` or any heavy/GPU module — doing so would pull the
orchestration layer into worker bundles and risk circular imports.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_PROMPTS_DIR = Path(__file__).resolve().parent


# ============================================================================
# CATALOG DATA FILES (bulk prompt collections, kept as JSON)
#   readers: services/logic.py (POSE_BY_ID / EXPRESSION_BY_ID / CAMERA_ANGLES_RAW),
#            services/image_edit_ai_service/serverless.py (pose / expression),
#            services/multi_angle_ai_service/serverless.py + run_batch_angles.py (angles)
# ============================================================================
POSE_PROMPTS_PATH = _PROMPTS_DIR / "pose_prompts.json"
EXPRESSION_PROMPTS_PATH = _PROMPTS_DIR / "expression_prompts.json"
CAMERA_ANGLES_PATH = _PROMPTS_DIR / "camera_angles.json"
LOCATION_PROMPT_CHECKLIST_PATH = _PROMPTS_DIR / "location_prompt_checklist.json"


def load_catalog(path: Path) -> list[dict[str, Any]]:
    """Load a JSON-array prompt catalog from ``path``."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"Catalog must be a JSON array: {path}")
    return data


# ============================================================================
# CHARACTER GENERATION
#   services/anime_img_gen_ai_service/serverless.py (Anima T2I),
#   services/logic.generate_character_base_draft_to_temp (new-character)
# ============================================================================

# Shared quality/anime style lead. Used both as the anime T2I default prefix and as the
# lead-in for the new-character composed prompt (previously duplicated in two modules).
ANIME_DEFAULT_STYLE_PREFIX = (
    "masterpiece, best quality, score_7, safe. anime, plain white background, full body view, "
)


def build_positive_prompt(user_prompt: str, style_prefix: str | None = None) -> str:
    """Prepend the anime style prefix to the user's scene/subject text."""
    prefix = (style_prefix or ANIME_DEFAULT_STYLE_PREFIX).strip()
    if prefix and not prefix.endswith((" ", ",")):
        prefix = prefix + " "
    elif prefix.endswith(","):
        prefix = prefix + " "
    body = (user_prompt or "").strip()
    return prefix + body


# Full positive lead for the new-character base draft (solo / full-frontal constraints).
NEW_CHARACTER_POSITIVE_LEAD = (
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
        return NEW_CHARACTER_POSITIVE_LEAD
    return f"{NEW_CHARACTER_POSITIVE_LEAD}, {u}"


# ============================================================================
# LOCATION GENERATION
#   services/logic.generate_location_base_draft_to_temp (new-location, location gallery)
# ============================================================================

# Full positive lead for a new-location base background (environment / no characters).
NEW_LOCATION_POSITIVE_LEAD = (
    "masterpiece, best quality, score_7, safe. anime, anime background art, "
    "studio-quality animation environment, cinematic composition, richly detailed scenery, "
    "depth and atmosphere, empty scene, no characters"
)


def compose_new_location_positive_prompt(user_description: str) -> str:
    """
    Build the full positive prompt for a new-location base background image.

    ``user_description`` is the scene the user typed (setting, mood, time of day, etc.).
    """
    u = (user_description or "").strip()
    if not u:
        return NEW_LOCATION_POSITIVE_LEAD
    return f"{NEW_LOCATION_POSITIVE_LEAD}, {u}"


# ============================================================================
# SHOT / COMPOSITING
#   services/logic.create_shot
# ============================================================================

# Fixed instruction prepended to every Create Shot generation. Image 1 is the
# pristine backdrop; image 2 is the backdrop+character composite from the editor.
SHOT_PROMPT_PREFIX = (
    "Image 1 is the original backdrop image reference for a film shot generation "
    "task. Image 2 is the reference for how characters should be integrated into "
    "the backdrop, with character poses roughly cropped into the image. Edit the "
    "character(s) into the image with seamless blending of lighting and contact "
    "point with surrounding environment."
)
SHOT_PROMPT_SCENE_JOINER = (
    " Here is a description of how the scene should be integrated: "
)


def build_shot_prompt(user_text: str | None) -> str:
    """Compose the final Qwen prompt for a shot from the user's scene text."""
    text = (user_text or "").strip()
    if not text:
        return SHOT_PROMPT_PREFIX
    return SHOT_PROMPT_PREFIX + SHOT_PROMPT_SCENE_JOINER + text


# ============================================================================
# POSE
#   services/logic.py (pose generation + keypoint flows),
#   services/image_edit_ai_service (pose catalog)
# ============================================================================

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

DEFAULT_KEYPOINT_ONLY_POSE_PROMPT = (
    "Match the reference body pose and skeleton; preserve the subject's identity, proportions, "
    "and clothing unless impossible."
)


def build_pose_prompt_from_label(short_desc: str) -> str:
    """Convert a short pose checklist label into the inline image-edit prompt."""
    desc = (short_desc or "").strip()
    if not desc:
        return ""
    return (
        f"Edit the subject to {desc}, keep identity and clothing coherent unless impossible."
    )


def append_closeup_keypoint_pose_hint(user_prompt: str) -> str:
    """Append backend hint when using starting image + closeup composite + keypoint auxiliaries."""
    u = (user_prompt or "").strip()
    s = POSE_KEYPOINT_CLOSEUP_PROMPT_SUFFIX.strip()
    if not u:
        return s
    return f"{u} {s}"


def append_keypoint_only_pose_hint(user_prompt: str) -> str:
    """Append backend hint when using starting image + keypoint auxiliary only (no closeup sheet)."""
    u = (user_prompt or "").strip()
    s = POSE_KEYPOINT_ONLY_ROLE_HINT.strip()
    if not u:
        return s
    return f"{u} {s}"


# ============================================================================
# EXPRESSION
#   services/logic.py (expression generation),
#   services/image_edit_ai_service (expression catalog)
# ============================================================================


def build_expression_prompt_from_label(short_desc: str) -> str:
    """Convert a short expression checklist label into the inline image-edit prompt."""
    desc = (short_desc or "").strip()
    if not desc:
        return ""
    return f"Edit the face to show {desc}, keep identity coherent."


# ============================================================================
# MULTI-ANGLE
#   services/multi_angle_ai_service/serverless.py + run_batch_angles.py
# ============================================================================

MULTI_ANGLE_BACKGROUND_PHRASE = "keep background blank white"


def append_default_multi_angle_background_instruction(prompt: str) -> str:
    """Append `, keep background blank white` after camera / user text (2511 multi-angle LoRA)."""
    phrase = MULTI_ANGLE_BACKGROUND_PHRASE
    p = (prompt or "").strip()
    if not p or phrase.lower() in p.lower():
        return p
    return f"{p}, {phrase}"


# ============================================================================
# OUTPAINT
#   services/outpaint_ai_service/serverless.py
# ============================================================================

DEFAULT_OUTPAINT_PROMPT = "beautiful scenery"


# ============================================================================
# TEST-MODE DEFAULTS
#   serverless --test-mode fallbacks (no user prompt supplied)
# ============================================================================

ANIME_TESTMODE_DEFAULT_PROMPT = "a girl reading a book by the window, soft morning light"
