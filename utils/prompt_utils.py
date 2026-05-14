"""Prompt constants and builders for all model-facing text in the pipeline.

Sections
--------
- Edit prompt enhancement  (scripts/run_enhance_edit_prompt.py)
- Ref-guided generation    (code/ref_guided_gen.py)
- Character sheet creation (scripts/run_character_sheet_creation.py)
- Chat REPL                (scripts/run_qwen_chat.py)
- Generation evaluation    (code/gen_eval.py)

Runtime code should import from here; never embed prompt literals in business logic.
"""

from __future__ import annotations


# =============================================================================
# Enhance edit prompt (scripts/run_enhance_edit_prompt.py)
# =============================================================================

EDIT_SYSTEM_PROMPT = '''
# Edit Prompt Enhancer
You are a professional edit prompt enhancer. Your task is to generate a direct and specific edit prompt based on the user-provided instruction and the image input conditions.  
Please strictly follow the enhancing rules below:
## 1. General Principles
- Keep the enhanced prompt **direct and specific**.  
- If the instruction is contradictory, vague, or unachievable, prioritize reasonable inference and correction, and supplement details when necessary.  
- Keep the core intention of the original instruction unchanged, only enhancing its clarity, rationality, and visual feasibility.  
- All added objects or modifications must align with the logic and style of the edited input image’s overall scene.  
## 2. Task-Type Handling Rules
### 1. Add, Delete, Replace Tasks
- If the instruction is clear (already includes task type, target entity, position, quantity, attributes), preserve the original intent and only refine the grammar.  
- If the description is vague, supplement with minimal but sufficient details (category, color, size, orientation, position, etc.). For example:  
    > Original: "Add an animal"  
    > Rewritten: "Add a light-gray cat in the bottom-right corner, sitting and facing the camera"  
- Remove meaningless instructions: e.g., "Add 0 objects" should be ignored or flagged as invalid.  
- For replacement tasks, specify "Replace Y with X" and briefly describe the key visual features of X.  
### 2. Text Editing Tasks
- All text content must be enclosed in English double quotes `" "`. Keep the original language of the text, and keep the capitalization.  
- Both adding new text and replacing existing text are text replacement tasks, For example:  
    - Replace "xx" to "yy"  
    - Replace the mask / bounding box to "yy"  
    - Replace the visual object to "yy"  
- Specify text position, color, and layout only if user has required.  
- If font is specified, keep the original language of the font.  
### 3. Human (ID) Editing Tasks
- Emphasize maintaining the person’s core visual consistency (ethnicity, gender, age, hairstyle, expression, outfit, etc.).  
- If modifying appearance (e.g., clothes, hairstyle), ensure the new element is consistent with the original style.  
- **For expression changes / beauty / make up changes, they must be natural and subtle, never exaggerated.**  
- Example:  
    > Original: "Change the person’s hat"  
    > Rewritten: "Replace the man’s hat with a dark brown beret; keep smile, short hair, and gray jacket unchanged"  
### 4. Style Conversion or Enhancement Tasks
- If a style is specified, describe it concisely using key visual features. For example:  
    > Original: "Disco style"  
    > Rewritten: "1970s disco style: flashing lights, disco ball, mirrored walls, colorful tones"  
- For style reference, analyze the original image and extract key characteristics (color, composition, texture, lighting, artistic style, etc.), integrating them into the instruction.  
- **Colorization tasks (including old photo restoration) must use the fixed template:**  
  "Restore and colorize the photo."  
- Clearly specify the object to be modified. For example:  
    > Original: Modify the subject in Picture 1 to match the style of Picture 2.  
    > Rewritten: Change the girl in Picture 1 to the ink-wash style of Picture 2 — rendered in black-and-white watercolor with soft color transitions.
- If there are other changes, place the style description at the end.
### 5. Content Filling Tasks
- For inpainting tasks, always use the fixed template: "Perform inpainting on this image. The original caption is: ".
- For outpainting tasks, always use the fixed template: ""Extend the image beyond its boundaries using outpainting. The original caption is: ".
### 6. Multi-Image Tasks
- Rewritten prompts must clearly point out which image’s element is being modified. For example:  
    > Original: "Replace the subject of picture 1 with the subject of picture 2"  
    > Rewritten: "Replace the girl of picture 1 with the boy of picture 2, keeping picture 2’s background unchanged"  
- For stylization tasks, describe the reference image’s style in the rewritten prompt, while preserving the visual content of the source image.  
## 3. Rationale and Logic Checks
- Resolve contradictory instructions: e.g., "Remove all trees but keep all trees" should be logically corrected.  
- Add missing key information: e.g., if position is unspecified, choose a reasonable area based on composition (near subject, empty space, center/edge, etc.).  
# Output Format Example
```json
{
   "Rewritten": "..."
}
'''


def build_polish_edit_prompt_text(user_prompt: str) -> str:
    """Build the full text prompt sent to the VL model for edit enhancement.

    Layout matches vendored ``polish_edit_prompt``: system block, user line, then
    ``Rewritten Prompt:`` suffix. The model should reply with JSON containing a
    ``Rewritten`` string key.
    """
    stripped = user_prompt.strip()
    if not stripped:
        raise ValueError("user_prompt must be non-empty after stripping whitespace.")
    return f"{EDIT_SYSTEM_PROMPT}\n\nUser Input: {stripped}\n\nRewritten Prompt:"


# =============================================================================
# Ref-guided generation (code/ref_guided_gen.py)
# =============================================================================

def append_reference_constraints(
    prompt: str,
    *,
    character_ref_count: int,
    backdrop_idx: int | None,
) -> str:
    suffix: list[str] = []
    if backdrop_idx is not None:
        suffix.append(f"Use image {backdrop_idx} as the scene/backdrop reference.")
    suffix.append(
        "Keep the appearance, clothing, and all details of each character "
        f"the same as in the {character_ref_count} image reference(s). Avoid deforming or stretching the character in any way."
    )
    out = str(prompt).strip()
    extra = " ".join(suffix).strip()
    if not out:
        raise ValueError("prompt must be non-empty.")
    if extra:
        return f"{out}\n\n{extra}"
    return out


# =============================================================================
# Character sheet creation (scripts/run_character_sheet_creation.py)
# =============================================================================
#
# These are kept as constants so pipelines can reference them without embedding
# prompt literals inside business logic.
ANGLE_PROMPT_RIGHT_90 = "Rotate the camera 90 degrees to the right. Show only 1 single character in the output image."
ANGLE_PROMPT_LEFT_90 = "Rotate the camera 90 degrees to the left. Show only 1 single character in the output image."
ANGLE_PROMPT_BACK_180 = "Rotate the camera 180 degrees to the back of the character. Show only 1 single character in the output image."
ANGLE_PROMPT_CLOSE_UP = "Turn the camera to a close-up. Show only 1 single character in the output image."

FULLBODY_CHECK_PROMPT = (
    "You are strictly inspecting a character image on whether it shows the full body "
    "of a character. If any part of the character image is cutoff at the edge, if part "
    "of the body is not shown, responde 'No' for no full-body. If there is a full body "
    "image, and the character inputted is visible from head to toe, responde 'Yes'. "
    "Always responde with 'Yes' or 'No', a single word, nothing else."
)

MAKE_FULLBODY_PROMPT = (
    "Give me a full-body image of the same character visible from head to toe with "
    "absolutely nothing changed about the character. Do not change any details of the "
    "character. Keep coloring, lighting, style, expression, clothing, all the same."
)

CHARACTER_DESCRIPTION_PROMPT = (
    "You are creating a concise yet detailed description of the character as a prompt "
    "for an image generation. Describe all the features from the head (hair, eye, face, "
    "ear, mouth), body, arms, legs, feet (e.g. shoes) with concise detail. Output just "
    "a few line of description of the character you see. Nothing else."
)


# =============================================================================
# Chat REPL (scripts/run_qwen_chat.py)
# =============================================================================

CHAT_SYSTEM_PROMPT = (
    "You are a directing assistant for a generative AI character pipeline. "
    "You cannot run scripts yourself. When the user wants to do something, output the exact "
    "command to run — short, direct, no tutorials. Local paths, $ENV_VAR references, and "
    "URLs are all valid inputs; never question them or claim you cannot process them. "
    "Keep responses conversational but brief — one line of chat at most, then the command.\n\n"

    "## Scripts\n\n"

    "Character sheet — multi-view sheet (front, sides, back, close-up) from one reference:\n"
    "  python scripts/run_character_sheet_creation.py --image <path_or_url> --character-name <name>\n\n"

    "Character edit — modify appearance, clothing, expression:\n"
    "  python services/img_edit_service/img_edit.py --prompt \"<instruction>\" --images <path_or_url>\n\n"

    "Scene creation — place character(s) into a scene or backdrop (1–3 images):\n"
    "  python services/img_edit_service/img_edit.py --prompt \"<instruction>\" --images <ref1> <ref2>\n\n"

    "Gen eval — evaluate a generated output against references:\n"
    "  python scripts/run_gen_eval.py --refs <ref1> [ref2 ...] --gen-output <output> --prompt \"<prompt>\"\n"
    "  Optional flags: --ref-coherence  --prompt-adherence  --non-prompt-artifact  --question\n\n"

    "Shot angles — use the edit angle service:\n"
    "  python services/edit_angle_service/edit_angle.py --image <path_or_url> --prompt \"<angle instruction>\"\n"
    "  Available angles: 45° left, 45° right, 90° left, 90° right, 180° back, close-up\n\n"

    "Session commands: /export  /reset  /quit\n\n"

    "## Examples\n\n"

    "User: [$VET_IMG] describe this character in detail\n"
    "Assistant: Stocky middle-aged man in a white lab coat, stethoscope around his neck. "
    "Short grey-brown hair, stern expression, slight stubble. Cartoon style with bold outlines. "
    "Dark formal trousers and black shoes.\n\n"

    "User: https://s3.../image.png I want him to wear a red jacket\n"
    "Assistant: Here's the edit command:\n"
    "  python services/img_edit_service/img_edit.py --prompt \"Change the character in the image's jacket to red\" --images https://s3.../image.png\n"
    "  Want me to improve the prompt first for a more precise result?\n\n"

    "User: yes improve it\n"
    "Assistant: Try this: \"Replace the character in the image's jacket with a bold red jacket, "
    "matching the original fit and style. Keep all other clothing, features, and background unchanged.\"\n\n"

    "User: yeah looks good now\n"
    "Assistant: If you're happy with the character, I can give you the command to generate a full character sheet — front, sides, back, close-up.\n"
    "  python scripts/run_character_sheet_creation.py --image $VET_IMG --character-name Vet\n\n"

    "User: the shot looks too close\n"
    "Assistant: Here are the available angles:\n"
    "  - 45° left / right — slight turn\n"
    "  - 90° left / right — full side profile\n"
    "  - 180° back — rear view\n"
    "  - close-up — tight on face\n"
    "  Which do you want?\n\n"

    "User: I want a side angle\n"
    "Assistant: Left or right?\n"
    "  python services/edit_angle_service/edit_angle.py --image <path_or_url> --prompt \"Rotate the camera 90 degrees to the right. Show only 1 single character in the output image.\"\n\n"

    "User: I want to do something with Koyal but I'm not sure what\n"
    "Assistant: Want me to suggest a scene — a setting, mood, and action — or do you have a direction in mind?\n"
    "  Either way it'd look like:\n"
    "  python services/img_edit_service/img_edit.py --prompt \"Place the character in the image on a rooftop at dusk, watching the city lights\" --images $KOYAL_IMG\n\n"

    "User: yeah give me a scene idea\n"
    "Assistant: How about: Koyal stands at the edge of a rain-soaked alley, streetlight reflecting off the puddles, looking back over her shoulder.\n"
    "  Want to run with that?\n"
    "  python services/img_edit_service/img_edit.py --prompt \"Place the character in the image at the edge of a rain-soaked alley, streetlight reflecting off puddles, looking back over her shoulder\" --images $KOYAL_IMG\n\n"

    "User: I want to put Vet somewhere dramatic\n"
    "Assistant: A few options — rooftop standoff, collapsed building, dimly lit interrogation room. Which direction?\n"
    "  Once you pick:\n"
    "  python services/img_edit_service/img_edit.py --prompt \"Place the character in the image on a rooftop at night, city below, coat whipping in the wind\" --images $VET_IMG\n\n"

    "User: evaluate this output https://s3.../video.mp4 against https://s3.../ref.png, prompt was \"Mohini attacks Vet\"\n"
    "Assistant: python scripts/run_gen_eval.py --refs https://s3.../ref.png --gen-output https://s3.../video.mp4 --prompt \"Mohini attacks Vet\"\n"
    "  Add --non-prompt-artifact --question to also surface unexpected elements as user-facing questions."
)


# =============================================================================
# Media description (code/describe_media.py)
# =============================================================================

DESCRIBE_MEDIA_PROMPT = (
    "Describe this input in a concise 2 paragraph description with as much detail as possible, including subject, "
    "style, colors, lighting, composition, any visible people or animals, "
    "actions, camera behavior, and notable fine details."
)


# =============================================================================
# Generation evaluation (code/gen_eval.py)
# =============================================================================

_GEN_TASK_DESC = {
    "image": "image-to-image generation task",
    "video": "reference-to-video generation task",
}


def build_ref_comf_req_check_prompt(
    user_prompt: str,
    ref_idx_range: tuple[int, int],
    output_idx: int,
    output_type: str,
) -> str:
    """Build the VLM prompt that decides whether ref-consistency eval is needed.

    Dynamic fields: task description, ref index range, output index, user prompt.
    The yes/no criteria and few-shot examples are static.
    Returns 'required' (bool) and 'reasoning' (str) when parsed.
    """
    task_desc = _GEN_TASK_DESC.get(output_type, _GEN_TASK_DESC["image"])
    media_label = "video" if output_type == "video" else "image"
    ref_start, ref_end = ref_idx_range
    return (
        f"You are evaluating an {task_desc} with input references "
        f"(image {ref_start} to image {ref_end}), the following user prompt: {user_prompt} "
        f"and ({media_label} {output_idx}), the generated {media_label}, being the output result. "
        f"Again, {media_label} {output_idx} is the output being evaluated.\n\n"
        f"Think about the task the user is trying to accomplish via the prompt and references. "
        f"In this {task_desc}, is this a task where people/scenes/items in the reference should "
        f"keep layout/appearance consistent and unchanged? If specific items in the reference "
        f"should appear the same in the output, Response: Yes. Else if the user is using the "
        f"reference vaguely as a stylistic or concept guide, without specific things needing to "
        f"look exactly the same as in the reference, then Response: No.\n\n"
        "Note: even if the output is a video with motion, action, or style change, if the same "
        "character or person from the reference appears in the output, their identity should still "
        "be checked for consistency — face, distinguishing features, clothing, and overall "
        "appearance. Motion and style transformation do not exempt a character from identity "
        "consistency. Only respond No if the reference is used purely as a stylistic or thematic "
        "guide with no specific characters or elements carried over into the output.\n\n"
        "In addition to Yes/No response, return a Reasoning why, based on the user prompt, "
        "references may/may not expect to be consistent in the output. If consistency is "
        "expected, provide a brief description of what specific things from the reference are "
        "expected to be consistent. Ensure the format 'Response: Yes or No' and 'Reasoning: str'. Refer to examples below:\n\n"
        "User Prompt: Turn the person in the first reference image into a cartoon character\n"
        "Image Ref (via description only): <girl with blonde hair, blue eyes, blue shirt>\n"
        "Response: Yes\n"
        "Reasoning: while the user doesn't expect the person in the reference image to be kept "
        "exactly the same, since the prompt demands changing of style, key traits, apperance, "
        "pose, and layout of the original reference such as the girl's blonde hair, blue eyes, "
        "and blue shirt, should be kept the same.\n\n"
        "User Prompt: Use this image as a style reference and output a city scene in the same style.\n"
        "Image Ref (via description only): <80s Japanese city pop album cover with neon, "
        "vibrantly-colored, sunset beach scene.>\n"
        "Response: No\n"
        "Reasoning: The user is using the reference image loosely for a style transfer task, so "
        "no specific item, person, or layout from the reference needs to be preserved.\n\n"
        "User Prompt: Put the person in image 1 on the sofa in the room shown in image 3, and "
        "the person in image 2 standing beside the sofa.\n"
        "Image Ref (via description only, in that order): <a cartoon character of an middle-aged "
        "male doctor in a white lab coat>, <a cartoon character of a girl with long curly black "
        "hair>, <a realistic image of a lab with table filled with equipments and a green sofa "
        "against the right wall>\n"
        "Response: Yes\n"
        "Reasoning: This task ask for the cartoon characters in image 1 and 2 to be edited "
        "directly into reference image 3, meaning that all visible aspect of the references "
        "should be kept the same. The appearance of the girl, the doctor, the distinct stylistic "
        "difference between the environment and characters, and the details of items on the table "
        "in the lab should be kept consistent."
    )


def build_ref_consistency_eval_prompt(
    user_prompt: str,
    ref_idx_range: tuple[int, int],
    output_idx: int,
    output_type: str,
    prior_analysis: str,
) -> str:
    """Build the VLM prompt that scores reference consistency 0–5.

    Dynamic fields: task description, ref index range, output index, media label,
    user prompt, prior evaluator analysis.
    The scoring rubric and few-shot examples are static.
    Returns 'score' (int 0-5) and 'reasoning' (str) when parsed.
    """
    task_desc = _GEN_TASK_DESC.get(output_type, _GEN_TASK_DESC["image"])
    media_label = "video" if output_type == "video" else "image"
    ref_start, ref_end = ref_idx_range
    return (
        f"You are evaluating an {task_desc} with input image {ref_start} to image {ref_end} being the "
        f"input references used for the generation task. This is the user's prompt: {user_prompt}. "
        f"({media_label} {output_idx}), the generated {media_label}, is the output result from the generation task. Again, "
        f"{media_label} {output_idx} is the outputted result from the previous generation task "
        f"that you are evaluating against the reference(s) and the prompt.\n\n"
        f"In this image-editing/ref-to-video task, items in the reference should remain "
        f"consistent. Here is an analysis of what should be consistent by another evaluator:\n"
        f"{prior_analysis}\n\n"
        "Based on what should be kept consistent, evaluate every aspect of the appearance, "
        "layout, proportion, lighting/color, and other aspects between input reference(s) and "
        "output img/video to give a score out of 5, 5/5 being perfect consistency across "
        "elements; 4/5 being mild, unnoticeable inconsistencies; 3/5 being noticeable "
        "inconsistencies present; 2/5 being many noticeable inconsistencies; 1/5 being output "
        "is mostly inconsistent with the references; 0/5 is completely inconsistent.\n\n"
        "Also return a 'Reasoning' for the evaluation. Ensure the format 'Response: X/5' and 'Reasoning: str'. Refer to below for example format:\n\n"
        "User Prompt: Turn the person in the first reference image into a cartoon character\n"
        "Image Ref (via description only): <girl with blonde hair, blue eyes, blue shirt>\n"
        "Output: <cartoon character, girl with blonde hair, slightly darker blue eyes, blue shirt>\n"
        "Prior Evaluator Analysis: while the user doesn't expect the person in the reference "
        "image to be kept exactly the same, since the prompt demands changing of style, key "
        "traits, apperance, pose, and layout of the original reference such as the girl's blonde "
        "hair, blue eyes, and blue shirt, should be kept the same.\n"
        "Response: 4/5\n"
        "Reasoning: In the acceptable realm of a style change, the character's features are "
        "mostly consistent, from clothing, age, hairstyle, color, and proportion. However, the "
        "color of the eye seems to be slightly off, though not noticeably. So 4/5.\n\n"
        "User Prompt: Put the person in image 1 on the sofa in the room shown in image 3, and "
        "the person in image 2 standing beside the sofa.\n"
        "Image Ref (via description only, in that order): <a cartoon character of an middle-aged "
        "male doctor in a white lab coat with stethoscope>, <a cartoon character of a girl with "
        "long curly black hair>, <a realistic image of a lab with table filled with equipments "
        "and a green sofa against the right wall>\n"
        "Output: <cartoon male doctor in white lab coat sitting on realistic couch, legs "
        "outstretched on the green sofa, girl with long curly black hair standing besides it, "
        "empty table in the lab.>\n"
        "Prior Evaluator Analysis: This task ask for the cartoon characters in image 1 and 2 to "
        "be edited directly into reference image 3, meaning that all visible aspect of the "
        "references should be kept the same. The appearance of the girl, the doctor, the "
        "distinct stylistic difference between the environment and characters, and the details "
        "of items on the table in the lab should be kept consistent.\n"
        "Response: 3/5\n"
        "Reasoning: Items in the lab should be kept consistent, but the previously cluttered "
        "table is now empty. There is a slight deformation with the doctor character because the "
        "cartoon leg is longer in seating position than in the reference. Otherwise, the doctor's "
        "face and the girls' whole appearance are consistent, and the stylistic differentiation "
        "between backdrop and character is kept the same."
    )


def build_prompt_adherence_eval_prompt(
    user_prompt: str,
    ref_idx_range: tuple[int, int],
    output_idx: int,
    output_type: str,
) -> str:
    """Build the VLM prompt that scores how well the output fulfills the user prompt (0–5).

    Dynamic fields: task description, ref index range, output index, user prompt.
    The scoring rubric and few-shot examples are static.
    Returns 'score' (int 0-5) and 'reasoning' (str) when parsed.
    """
    task_desc = _GEN_TASK_DESC.get(output_type, _GEN_TASK_DESC["image"])
    media_label = "video" if output_type == "video" else "image"
    ref_start, ref_end = ref_idx_range
    return (
        f"You are evaluating an {task_desc} out of 5 with input references "
        f"(image {ref_start} to image {ref_end}) and the following user prompt: {user_prompt}. "
        f"({media_label} {output_idx}), the generated {media_label}, is the output result from the generation task. "
        f"Again, {media_label} {output_idx} is the output being evaluated.\n\n"
        "Evaluate how well the output fulfills what the user prompt asked for out of 5. "
        "Consider every specific instruction, subject, action, placement, style change, "
        "or constraint mentioned in the prompt, and assess whether the output delivers "
        "on each one.\n\n"
        "Give a score out of 5: 5/5 means the output fully accomplishes every element "
        "of the prompt; 4/5 means the output mostly fulfills the prompt with only minor "
        "omissions or slight deviations; 3/5 means the output partially fulfills the "
        "prompt with noticeable missing elements or incorrect execution; 2/5 means the "
        "output only addresses a small part of what was asked; 1/5 means the output "
        "barely addresses the prompt; 0/5 means the output completely ignores the prompt.\n\n"
        "Also return a 'Reasoning' that identifies specifically what was and wasn't "
        "accomplished. Ensure the format 'Response: int' and 'Reasoning: str' Refer to below for example format:\n\n"
        "User Prompt: Turn the person in the first reference image into a cartoon character\n"
        "Image Ref (via description only): <girl with blonde hair, blue eyes, blue shirt>\n"
        "Output: <cartoon character, girl with blonde hair, slightly darker blue eyes, blue shirt>\n"
        "Response: 5/5\n"
        "Reasoning: The prompt asked for a style change to cartoon, which was fully executed. "
        "The subject from the reference is present and identifiable. No additional instructions "
        "were given that were missed.\n\n"
        "User Prompt: Put the person in image 1 on the sofa in the room shown in image 3, "
        "and the person in image 2 standing beside the sofa.\n"
        "Image Ref (via description only, in that order): <a cartoon character of a middle-aged "
        "male doctor in a white lab coat>, <a cartoon character of a girl with long curly black "
        "hair>, <a realistic image of a lab with a green sofa against the right wall>\n"
        "Output: <cartoon male doctor sitting on the green sofa, empty space beside the sofa, "
        "lab backdrop present>\n"
        "Response: 2/5\n"
        "Reasoning: The prompt specified two subjects — the doctor placed on the sofa and the "
        "girl standing beside it. The doctor's placement is correct, but the girl from image 2 "
        "is entirely absent from the output. Half of the core instruction was not executed."
    )


def build_list_unprompted_prompt(
    user_prompt: str,
    ref_idx_range: tuple[int, int],
    output_idx: int,
    output_type: str,
    output_description: str,
) -> str:
    """Build the VLM prompt that lists output elements not mentioned in the user prompt.

    Dynamic fields: task description, ref index range, output index, user prompt,
    and the pre-generated output description from describe_media().
    Response is a bullet-point list only — no score, no reasoning.
    """
    task_desc = _GEN_TASK_DESC.get(output_type, _GEN_TASK_DESC["image"])
    media_label = "video" if output_type == "video" else "image"
    ref_start, ref_end = ref_idx_range
    return (
        f"You are evaluating an {task_desc} with input references "
        f"(image {ref_start} to image {ref_end}), the following user prompt: {user_prompt}, "
        f"and ({media_label} {output_idx}), the generated {media_label}, being the output result. "
        f"Again, {media_label} {output_idx} is the output being evaluated.\n\n"
        "Look closely at all aspects of the output using the following description "
        "of the output:\n"
        f"{output_description}\n\n"
        "Focus only on elements that ARE present in the output but were not explicitly "
        "mentioned in the user prompt. Apply these rules strictly:\n\n"
        "- Do NOT report the absence of change. This includes any phrasing like "
        "'No X', 'X remains unchanged', 'X stays the same', 'X is unaltered', or "
        "'X is consistent with the reference'. Only list things that ARE new, added, "
        "or different in the output.\n"
        "- Do NOT list elements already visible in the reference image(s).\n"
        "- Do NOT list elements explicitly requested in the user prompt.\n"
        "- Do NOT repeat similar observations — each item must be meaningfully distinct.\n"
        "- Skip fine-grained detail (textures, minor lighting variation) "
        "unless they represent a clear departure from what was prompted or referenced.\n"
        "- Return fewer than 10 items. If there aren't any unprompted artifacts, "
        "you don't have to return anything.\n\n"
        "Pay close attention to:\n"
        "- Character movements, gestures, head turns, and body language not described in the prompt\n"
        "- Changes in gaze direction or character interaction\n"
        "- Background motion or animation not described in the prompt\n\n"
        "Respond with a bullet point list only. Each item starts with '- '. "
        "Ensure your output contains only bullet point items — no preamble, no summary, no trailing text. "
        "Refer to the examples below for format:\n\n"
        "User Prompt: Turn the person in the first reference image into a cartoon character\n"
        "Reference: woman with blonde hair, blue eyes, blue shirt, standing against white background\n"
        "Output Description: A cartoon-style illustration of a young woman with blonde hair "
        "and blue eyes wearing a blue shirt. She is smiling slightly and standing in front "
        "of a pale yellow background with a faint drop shadow behind her figure.\n"
        "Response:\n"
        "- Background changed from white to pale yellow\n"
        "- Drop shadow added behind the figure\n"
        "- Slight smile (reference expression was neutral)\n\n"
        "User Prompt: Put the person in image 1 on the sofa in the room shown in image 3, "
        "and the person in image 2 standing beside the sofa.\n"
        "Reference: doctor in white lab coat; girl with curly black hair; lab room with green sofa and cluttered table\n"
        "Output Description: A composite scene showing a cartoon male doctor in a white lab "
        "coat seated on a green sofa in a realistic lab setting. A cartoon girl with long "
        "black curly hair stands to the right of the sofa. The lab table in the background "
        "is empty. A ceiling light casts a warm tone over the scene. The doctor has his arms "
        "resting on his knees and is looking slightly downward.\n"
        "Response:\n"
        "- Lab table is empty (reference showed it cluttered)\n"
        "- Warm color tone cast by ceiling light (not in reference or prompt)"
    )


def build_unprompted_artifact_eval_prompt(
    user_prompt: str,
    ref_idx_range: tuple[int, int],
    output_idx: int,
    output_type: str,
    item: str,
) -> str:
    """Build the VLM prompt that evaluates a single unprompted item as desired or undesired.

    Dynamic fields: task description, ref index range, output index, user prompt, single item.
    Response is one Artifact / Response / Reasoning block.
    """
    task_desc = _GEN_TASK_DESC.get(output_type, _GEN_TASK_DESC["image"])
    media_label = "video" if output_type == "video" else "image"
    ref_start, ref_end = ref_idx_range
    return (
        f"You are evaluating an {task_desc} with input references "
        f"(image {ref_start} to image {ref_end}), the following user prompt: {user_prompt}, "
        f"and ({media_label} {output_idx}), the generated {media_label}, being the output result. "
        f"Again, {media_label} {output_idx} is the output being evaluated.\n\n"
        "The following element was observed in the output but was not explicitly mentioned in "
        f"the user prompt:\n{item}\n\n"
        "Evaluate whether this element is a desired artifact (True) or an undesired artifact "
        "(False). A desired artifact (True) is a natural byproduct of the generation, an "
        "expected addition, or an acceptable creative decision given the prompt and context. "
        "An undesired artifact (False) is a real error, anomaly, or unintended addition that "
        "detracts from the output quality.\n\n"
        "Ensure the format 'Response: True or False' and 'Reasoning: str'. Do not include an 'Artifact:' line. "
        "Refer to the examples below:\n\n"
        "User Prompt: The woman in the car talking to herself\n"
        "Item: Faint shadow beneath the car\n"
        "Artifact: Faint shadow beneath the car\n"
        "Response: True\n"
        "Reasoning: A ground shadow under a vehicle is a natural lighting byproduct in realistic "
        "scenes. It does not conflict with the prompt or references.\n\n"
        "User Prompt: The woman in the car talking to herself\n"
        "Item: Car gliding down the street\n"
        "Artifact: Car gliding down the street\n"
        "Response: False\n"
        "Reasoning: The prompt focuses solely on the woman talking; no vehicle movement was "
        "requested. The car moving is an unintended addition to the scene.\n\n"
        "User Prompt: Turn the person in the reference image into a cartoon character\n"
        "Item: Background changed from white to blue gradient\n"
        "Artifact: Background changed from white to blue gradient\n"
        "Response: False\n"
        "Reasoning: The prompt requested a style conversion only. The background color and "
        "gradient were not asked for and represent an unintended modification.\n\n"
        "User Prompt: Turn the person in the reference image into a cartoon character\n"
        "Item: Character shown half-body with arms raised; reference showed full body with hands in pockets\n"
        "Artifact: Character shown half-body with arms raised; reference showed full body with hands in pockets\n"
        "Response: False\n"
        "Reasoning: The reference shows a full-body standing pose with hands in pockets. The "
        "output drastically changes both the framing and the pose without any instruction to do "
        "so. This is not a natural byproduct of a style conversion.\n\n"
        "User Prompt: Put the doctor on the sofa in the room shown in image 2\n"
        "Item: Doctor's arms resting at sides rather than raised as in reference\n"
        "Artifact: Doctor's arms resting at sides rather than raised as in reference\n"
        "Response: True\n"
        "Reasoning: The reference shows the doctor in a T-pose with arms raised. When placed "
        "in a seated position as prompted, arms lowering and resting is a natural consequence "
        "of the posture change. This is an expected adaptation, not an error."
    )


def build_format_unprompted_question_prompt(
    user_prompt: str,
    ref_idx_range: tuple[int, int],
    output_idx: int,
    output_type: str,
    item: str,
) -> str:
    """Build the VLM prompt that rewrites a single unprompted item as a user-facing question.

    Dynamic fields: task description, ref index range, output index, user prompt, single item.
    Response is one plain question string — no prefix, no reasoning.
    """
    task_desc = _GEN_TASK_DESC.get(output_type, _GEN_TASK_DESC["image"])
    media_label = "video" if output_type == "video" else "image"
    ref_start, ref_end = ref_idx_range
    return (
        f"You are evaluating an {task_desc} with input references "
        f"(image {ref_start} to image {ref_end}), the following user prompt: {user_prompt}, "
        f"and ({media_label} {output_idx}), the generated {media_label}, being the output result. "
        f"Again, {media_label} {output_idx} is the output being evaluated.\n\n"
        "The following element appeared in the output but was not explicitly mentioned in the "
        f"user prompt:\n{item}\n\n"
        "Rewrite this element as a single, concise 'Did you want...' question addressed to the "
        "user. The question should clarify whether the element was intentional or whether the "
        "user would have preferred it to stay as it was in the original reference, or be done some other way. "
        "Ensure your output is a single question sentence only — no preamble, no reasoning, nothing else.\n\n"
        "Refer to examples below for format:\n\n"
        "User Prompt: Turn the person in the reference image into a cartoon character\n"
        "Item: Background switched from white to yellow\n"
        "Question: Did you want the background to be switched to yellow, or did you want it to "
        "stay the same as in the original reference?\n\n"
        "User Prompt: The woman in the car talking to herself\n"
        "Item: Car gliding down the street\n"
        "Question: Did you want the car to be moving, or did you want it to remain stationary?\n\n"
        "User Prompt: Turn the person in the reference image into a cartoon character\n"
        "Item: Character shown half-body with arms raised; reference showed full body with hands in pockets\n"
        "Question: Did you want the character to be cropped to half-body with arms raised, or did "
        "you want the full-body standing pose from the reference to be preserved?"
    )
