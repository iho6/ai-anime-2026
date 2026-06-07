# Qwen-Image 2512 text-to-image (reference gen) service

Text-to-image using [`workflows/image_qwen_t2i_api.json`](workflows/image_qwen_t2i_api.json) (Qwen-Image 2512 UNet + Qwen2.5-VL CLIP + Qwen-Image VAE). The text encoder and VAE are the **same files** already downloaded for the Qwen image-edit services, so only the base diffusion model is a new download.

## Job input

- **`prompt`** (string, required): the text prompt.
- **`width`** (int, optional): output width (default `1024`).
- **`height`** (int, optional): output height (default `1024`).

All other inputs (seed, steps, cfg, sampler, models) are defaulted by the
workflow. The seed is randomized on every run (KSampler node `8`). Width/height
are applied to the single latent node (`7` `EmptySD3LatentImage`); the KSampler
infers its dimensions from the latent.

### Response

```json
{
  "created_at": 0,
  "queued_at": 0,
  "results": [
    {
      "prompt_index": 0,
      "user_prompt": "a serene mountain lake at golden hour",
      "full_prompt": "a serene mountain lake at golden hour",
      "url": "https://..."
    }
  ],
  "error": null
}
```

## Models

Weights expected by the workflow: `qwen_image_2512_fp8_e4m3fn.safetensors` (UNet),
`qwen_2.5_vl_7b_fp8_scaled.safetensors` (CLIP, type `qwen_image`),
`qwen_image_vae.safetensors` (VAE). Download with
`python utils/download_models.py --qwen-t2i` (the CLIP + VAE dedupe against the
edit-service downloads).

## Local test mode

ComfyUI on 8188:

```bash
python -m services.t2i_ref_gen_ai_service.serverless --test-mode --enable-default --prompt "a serene mountain lake at golden hour" --width 768 --height 1024
```

## Docker

```bash
bash services/t2i_ref_gen_ai_service/deployment/buildspec.sh
```

Container `CMD`: `--enable-t2i-ref-gen --serverless`.

## Shared deps

Uses [`services.constant`](../../constant.py) / [`services.utils`](../../utils.py) (S3, Comfy queue, timeouts).
