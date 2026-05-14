# FLF2Video AI service (Wan 2.2 FLF2V Lightning)

First–last frame → short video using ComfyUI workflow **`video_wan2_2_14B_flf2v_lightning_api`** (see `workflows/`). Runtime code loads only that API graph; the other JSON files in `workflows/` are **reference** only:

| File | Role |
|------|------|
| `video_wan2_2_14B_flf2v_lightning_api.json` | **Executed** by this service (`load_workflows` key: `video_wan2_2_14B_flf2v_lightning_api`) |
| `video_wan2_2_14B_flf2v_api.json` | Reference (non-lightning / alternate API) |
| `video_wan2_2_14B_flf2v.json` | Reference (full UI-style graph) |

`CreateVideo` in the lightning graph uses **`fps: 16`**. The Wan node **`length`** (default **33**) controls generated frame count. For best compatibility with this setup, prefer lengths in the **4k+1** sequence **33, 37, 41, … 81, 85, …**; the API still accepts other integers if the node allows them.

## Required models (lightning)

ComfyUI must find these **exact filenames** under the Comfy working directory (usually repo root when you run `python main.py` here). If any are missing, `POST /prompt` fails with **Value not in list** on `CLIPLoader` / `UNETLoader` / `VAELoader` / `LoraLoaderModelOnly`.

| File | Relative path |
|------|----------------|
| umt5 (Wan text encoder) | `models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` |
| VAE | `models/vae/wan_2.1_vae.safetensors` |
| UNet high noise | `models/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` |
| UNet low noise | `models/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` |
| Lightning LoRA (high) | `models/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` |
| Lightning LoRA (low) | `models/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` |

**Size:** two 14B-class diffusion checkpoints plus encoder/VAE/LoRAs — expect **tens of GB** total; use a fast disk and stable network.

**Download** (from repo root, same cwd as Comfy):

```bash
python utils/download_models.py --flf-lightning [--hf-token YOUR_TOKEN]
```

Included in `python utils/download_models.py --all` (deduplicated by path). Set `HF_TOKEN` if Hugging Face returns 401/403.

**Verify**

1. Restart Comfy so it rescans `models/`.
2. In the UI, confirm each name appears in the corresponding loader widgets (CLIP type **wan** for umt5).
3. Smoke test:

```bash
python -m services.flf2video_ai_service.serverless --test-mode --enable-default --individual-frames \
  --image-url '["./path/to/a.png","./path/to/b.png"]' --frames 1,2 --length 33
```

## RunPod / JSON `input`

- **`image_url`** or **`image_urls`**: ordered list of sources (URLs or paths). Same rules as other services (`normalize_image_urls`).
- **`frames`** (required): at least two **1-based** indices into `image_urls`. Consecutive entries define first/last pairs, e.g. `[1,2,3,4]` → three jobs: frames 1→2, 2→3, 3→4.
- **`length`** (optional): single integer, default **33**.
- **`lengths`** (optional): list of integers, one per pair. If there are **more** values than pairs, the first *n_pairs* are used (**warning** logged). If **fewer**, the list is padded with the last given value (or **33** if empty) (**warning** logged).
- **`positive_prompt`** (optional): positive CLIP text; negative stays as in the workflow JSON.
- **`individual_frames`** (optional): if true, each pair’s output video is decoded to PNGs under `output/flf2video_frames/…` and the API returns **`frame_urls`** instead of **`url`**. Per-job override; process default from **`--individual-frames`** or env **`FLF2VIDEO_INDIVIDUAL_FRAMES=1`**.

### Example

```json
{
  "input": {
    "image_urls": ["https://example.com/a.png", "https://example.com/b.png", "https://example.com/c.png"],
    "frames": [1, 2, 3],
    "lengths": [33, 41],
    "positive_prompt": "cinematic motion, smooth transition"
  }
}
```

### Response

**Video mode (default):** each result has a single **`url`** (the generated video).

```json
{
  "created_at": 0,
  "queued_at": 0,
  "results": [
    { "pair_index": 0, "frame_start": 1, "frame_end": 2, "length": 33, "url": "..." },
    { "pair_index": 1, "frame_start": 2, "frame_end": 3, "length": 41, "url": "..." }
  ],
  "error": null
}
```

**Individual-frames mode** (`individual_frames` true via input, CLI, or env): each result has **`frame_urls`** (ordered PNG URLs) and **no** **`url`**.

```json
{
  "results": [
    {
      "pair_index": 0,
      "frame_start": 1,
      "frame_end": 2,
      "length": 33,
      "frame_urls": ["http://127.0.0.1:8188/view?filename=frame_000001.png&type=output&subfolder=...", "..."]
    }
  ],
  "error": null
}
```

On failure, `error` is set and processing stops at the first failing pair.

## Local `--test-mode`

With ComfyUI listening (e.g. port 8188):

```bash
python -m services.flf2video_ai_service.serverless --test-mode --enable-default \
  --image-url '["./a.png","./b.png","./c.png"]' \
  --frames 1,2,3 \
  --length 33,41
```

Single image URL with two frames is invalid; you need at least two images for two indices. `--length 33` applies one length to all pairs (via `length` field).

Optional: `--positive-prompt "..."`  
Optional: `--convert-local-to-url` (S3 staging, same env as other services)  
Optional: `--individual-frames` — decode each output video to PNGs and return `frame_urls` (same as `input.individual_frames: true`). You can also set **`FLF2VIDEO_INDIVIDUAL_FRAMES=1`** so RunPod/docker CMD does not need the flag; per-job `input.individual_frames` still overrides.

## Docker

From repo root:

```bash
bash services/flf2video_ai_service/deployment/buildspec.sh
```

Container entrypoint: `services/flf2video_ai_service/entrypoint.sh`  
Default CMD: `--enable-flf2video --serverless`

The runtime image **does not** bundle Wan weights (they are huge). Either run `python utils/download_models.py --flf-lightning` inside the container on first boot, or mount a host/volume directory over `/anime2026/models` (see [`deployment/README.md`](deployment/README.md)).

## Files

| File | Role |
|------|------|
| `core.py` | Patch `WanFirstLastFrameToVideo` + `LoadImage` nodes, pair loop, history → URL or PNG `frame_urls` (PyAV) |
| `serverless.py` | RunPod handler + CLI |
| `workflows/*.json` | Comfy graphs (only lightning API used at runtime) |
