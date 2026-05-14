# Anime image gen AI service (Anima preview)

Text-to-image using [`workflows/image_anima_preview.json`](workflows/image_anima_preview.json) (Anima preview UNet + Qwen CLIP + Qwen VAE).

## Prompt handling

The workflow’s positive CLIP node (`11`) expects a **quality + anime** prefix. The serverless handler **prepends** this automatically:

`masterpiece, best quality, score_7, safe. anime, `

**You only pass the subject/scene** in `prompt` or `prompts` — do not repeat the style block unless you use `style_prefix` to replace it entirely.

### Job input

- **`prompt`** (string): one generation.
- **`prompts`** (string[]): multiple generations in one job (sequential).

Optional:

- **`style_prefix`**: override the default prefix (include trailing space/comma as you want).
- **`negative_prompt`**: override node `12` negative text for all runs in the job.

### Response

```json
{
  "created_at": 0,
  "queued_at": 0,
  "results": [
    {
      "prompt_index": 0,
      "user_prompt": "a girl under cherry blossoms",
      "full_prompt": "masterpiece, best quality, score_7, safe. anime, a girl under cherry blossoms",
      "url": "https://..."
    }
  ],
  "error": null
}
```

## Models

From repo root:

```bash
python utils/download_models.py --anime-gen [--hf-token YOUR_TOKEN]
```

Weights: `anima-preview.safetensors`, `qwen_3_06b_base.safetensors`, `qwen_image_vae.safetensors` (see CircleStone [Anima](https://huggingface.co/circlestone-labs/Anima)).

## Local test mode

ComfyUI on 8188:

```bash
python -m services.anime_img_gen_ai_service.serverless --test-mode --enable-default --prompt "robot cat on a rooftop at sunset"
python -m services.anime_img_gen_ai_service.serverless --test-mode --enable-default --prompts-json "[\"scene one\",\"scene two\"]"
```

## Docker

```bash
bash services/anime_img_gen_ai_service/deployment/buildspec.sh
```

Container `CMD`: `--enable-anime-img-gen --serverless`.

## Shared deps

Uses [`services.constant`](../../constant.py) / [`services.utils`](../../utils.py) (S3, Comfy queue, timeouts).
