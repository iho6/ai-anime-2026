# Image edit AI service (Qwen Image Edit 2509)

Batch **image → edited image** runs using ComfyUI workflow `image_qwen_image_edit_2509.json` (Qwen-Image-Edit 2509 + Lightning LoRA).

## Prompt modes

### A — Inline nested prompts

```json
{
  "input": {
    "image_urls": ["https://example.com/a.png", "https://example.com/b.png"],
    "prompt_source": "inline",
    "prompts": [
      ["Edit: add a red hat", "Edit: remove background"],
      ["Edit: smile more"]
    ]
  }
}
```

Single image may use a **flat** list: `"prompts": ["p1", "p2"]`.

Omit `prompt_source` or set `"inline"`.

### Optional extra conditioning images (Qwen Edit Plus)

Pass **`auxiliary_image_urls`**: an array of up to **two** URLs or paths. They map to **image2** and **image3** on `TextEncodeQwenImageEditPlus` (e.g. pose keypoint skeleton on slot 2 while **`image_url` / `image_urls`** remain the primary edit target for **image1** and the VAE latent).

```json
{
  "input": {
    "image_url": "https://example.com/base.png",
    "prompt_source": "inline",
    "prompts": ["Match the pose from the reference skeleton."],
    "auxiliary_image_urls": ["https://example.com/skeleton.png"]
  }
}
```

Do **not** put the skeleton in `image_urls` alongside the base for a single pose job: `image_urls` defines separate **primary** images (one matrix row each), not extra conditioning slots.

### B — Bundled catalogs (`pose` / `expression`)

- **`pose_prompts.json`** — ~100 full-body pose edits (`prompt_source`: `"pose"`).
- **`expression_prompts.json`** — ~100 face-expression edits (`prompt_source`: `"expression"`).

You must pass **`indices`** (same poses for every image) or **`indices_per_image`** (list aligned with `image_urls`), **or** set **`run_full_catalog`: true** to run every catalog row per image (expensive).

```json
{
  "input": {
    "image_urls": ["https://example.com/person.png"],
    "prompt_source": "pose",
    "indices": [0, 5, 12]
  }
}
```

### C — Custom JSON file

`"prompt_source": "file"` and `"prompt_catalog_path": "my_prompts.json"` (relative to this service directory) or an absolute path. Same row schema: `{ "id", "prompt_text", optional "label" }`.

## Response

```json
{
  "created_at": 1234567890,
  "queued_at": 1234567890,
  "results": [
    {
      "image_index": 0,
      "prompt_index": 0,
      "prompt": "...",
      "url": "https://...",
      "catalog_id": 0
    }
  ],
  "error": null
}
```

If `error` is set, `results` may be partial (implementation stops on first failure).

## Models

```bash
python utils/download_models.py --image-edit [--hf-token YOUR_TOKEN]
```

## Local test mode

Start ComfyUI on port 8188, then:

```bash
python -m services.image_edit_ai_service.serverless --test-mode --enable-default --image-url https://example.com/i.png --prompts-json "[\"Edit: waving hello\"]"
```

Local file paths are supported in `--image-url` during test mode. They are uploaded directly to ComfyUI's input folder through `/upload/image` (no temporary S3 staging required).

Optional second conditioning image (e.g. keypoint skeleton):

```bash
python -m services.image_edit_ai_service.serverless --test-mode --enable-default \
  --image-url /path/to/base.png \
  --auxiliary-image-urls-json '["/path/to/skeleton.png"]' \
  --prompts-json '["Edit to match the pose reference."]'
```

Pose catalog smoke test:

```bash
python -m services.image_edit_ai_service.serverless --test-mode --enable-default --image-url https://example.com/i.png --prompt-source expression --indices-json "[0,1]"
```

## Docker

From repo root:

```bash
bash services/image_edit_ai_service/deployment/buildspec.sh
```

Container starts ComfyUI + `runpod.serverless` with `CMD ["--enable-image-edit","--serverless"]`.

## Files

| File | Role |
|------|------|
| `core.py` | Resolve prompts, Comfy loop, S3 uploads |
| `serverless.py` | RunPod handler |
| `pose_prompts.json` / `expression_prompts.json` | Catalogs |
| `workflows/image_qwen_image_edit_2509.json` | API graph |

Regenerate catalogs: `python services/image_edit_ai_service/_generate_catalogs.py` (if that helper script is present).
