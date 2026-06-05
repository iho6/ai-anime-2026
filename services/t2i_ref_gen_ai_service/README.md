# Flux2 text-to-image (reference gen) service

Text-to-image using [`workflows/image_flux2_t2i_api.json`](workflows/image_flux2_t2i_api.json) (Flux2 dev UNet + Mistral-Small Flux2 CLIP + Flux2 VAE, optional Turbo LoRA).

## Job input

- **`prompt`** (string, required): the text prompt.
- **`width`** (int, optional): output width (default `1024`).
- **`height`** (int, optional): output height (default `1024`).

All other inputs (seed, steps, guidance, sampler, models, LoRA) are defaulted by
the workflow. The seed is randomized on every run. Width/height are applied to
**both** the latent (`98:47` `EmptyFlux2LatentImage`) and the scheduler
(`98:48` `Flux2Scheduler`) nodes, which must match.

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

Weights expected by the workflow: `flux2_dev_fp8mixed.safetensors` (UNet),
`mistral_3_small_flux2_bf16.safetensors` (CLIP, type `flux2`),
`flux2-vae.safetensors` (VAE), `Flux_2-Turbo-LoRA_comfyui.safetensors` (LoRA).

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
