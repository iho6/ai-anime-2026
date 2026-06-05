# Flux.1 Fill mask-guided inpaint service

Mask-guided inpaint using [`workflows/flux_fill_inpaint_example.json`](workflows/flux_fill_inpaint_example.json) (Flux.1 **Fill** dev UNet + `clip_l`/`t5xxl` DualCLIP + Flux VAE, DifferentialDiffusion + InpaintModelConditioning).

## Job input

- **`image_url`** (string, required): an **RGBA** image whose **alpha channel encodes the mask**. `alpha=255` (opaque) = KEEP, `alpha=0` (transparent) = the region to regenerate. ComfyUI's `LoadImage` derives its MASK output as `1 - alpha`, so no separate mask file is needed.
- **`prompt`** (string, required): the text prompt describing what to paint into the masked region.

All other inputs (seed, steps, guidance, sampler, models) are defaulted by the
workflow. The seed is randomized on every run.

> The mask is baked into the alpha channel **before** the image is sent. The
> backend helper `services.logic.run_mask_guided_edit(...)` does this merge with
> PIL from a separate RGB image + B/W mask; the service itself is mask-unaware.

### Response

```json
{
  "created_at": 0,
  "queued_at": 0,
  "results": [
    {
      "prompt_index": 0,
      "user_prompt": "a red hat",
      "full_prompt": "a red hat",
      "url": "https://..."
    }
  ],
  "error": null
}
```

## Models

Weights expected by the workflow: `flux1-fill-dev.safetensors` (UNet),
`clip_l.safetensors` + `t5xxl_fp16.safetensors` (DualCLIP, type `flux`),
`ae.safetensors` (VAE). Needs ~24GB VRAM.

## Local test mode

ComfyUI on 8188, with an RGBA PNG whose alpha=0 over the edit region:

```bash
python -m services.mask_guided_edit_ai_service.serverless --test-mode --enable-default --image-url /path/to/rgba.png --prompt "a red hat" --convert-local-to-url
```

## Docker

```bash
bash services/mask_guided_edit_ai_service/deployment/buildspec.sh
```

Container `CMD`: `--enable-mask-guided-edit --serverless`.

## Shared deps

Uses [`services.constant`](../../constant.py) / [`services.utils`](../../utils.py) (S3, Comfy queue, timeouts).
