# Multi-angle AI service

Uses [fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA](https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA) for 96 camera poses (8 azimuths × 4 elevations × 3 distances).

## Layout

| Path | Purpose |
|------|---------|
| `workflows/` | ComfyUI API + UI JSON |
| `serverless.py` | RunPod serverless handler + local `--test-mode` |
| `run_batch_angles.py` | Local batch against a running ComfyUI |
| `entrypoint.sh` | Start ComfyUI + serverless worker (Docker) |
| `deployment/` | `Dockerfile.builder`, `Dockerfile.runtime`, dockerignore, `buildspec.sh` |
| `camera_angles.json` | All 96 `prompt_text` entries |
| `angle_library/` | Per-image cache (created at runtime; override with env) |

## Input format (serverless)

- **`image_url`** (required): HTTP(S) URL, UUID, or local filesystem path.
- **`angle_id`**: `0`–`95` (indexes `camera_angles.json`).
- **`prompt_text`** (optional): Overrides the JSON prompt for this run; `angle_id` still selects the cache folder `angle_XXX`.
- **`library_key`** (optional): Stable subdirectory name under `angle_library/` instead of `basename_<contenthash>`.

Response shape is unchanged: `variations.items[0].result.url` (S3 public URL) or `error`.

## Angle library cache

Default root: `services/multi_angle_ai_service/angle_library`. Override with **`MULTI_ANGLE_LIBRARY_DIR`**.

For each source image:

```
angle_library/<key>/starting_image.<ext>
angle_library/<key>/angle_000/<timestamp>_<uuid>.png
...
angle_library/<key>/angle_095/...
```

`<key>` is `library_key` if set; otherwise `<sanitized_stem>_<sha256-prefix>` of the file contents.

## Models

Default diffusion UNet is **Comfy-Org FP8-mixed** (`qwen_image_edit_2511_fp8mixed.safetensors`, ~20 GB), not the 38 GB BF16 file. Lightning 4-step + fal multi-angle LoRAs are unchanged.

From repo root:

```bash
python utils/download_models.py --multi-angle [--hf-token YOUR_TOKEN]
```

Comfy VRAM mode (API launch): `COMFY_VRAM_MODE=normalvram` (default) or `lowvram` if OOM.

If FP8-mixed is still too slow/OOM: try a community `fp8_e4m3fn` UNet (armychimp / drbaph / xms991 on Hugging Face), or GGUF + [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF). Avoid running a second Comfy (e.g. photoreal on 8188) on the same GPU during multi-angle.

## RunPod cached models (optional)

See `cache_models.json` and `scripts/setup_hf_cache_repo.py` in your deployment docs if you mirror Hugging Face cache repos per service.

## Batch (local ComfyUI)

Requires GPU Comfy listening on `--server` (default `127.0.0.1:8188`).

```bash
python -m services.multi_angle_ai_service.run_batch_angles path/to/image.png
python -m services.multi_angle_ai_service.run_batch_angles path/to/image.png --numb-angles 8 --skip-cached
python -m services.multi_angle_ai_service.run_batch_angles path/to/image.png --library-key my_character_v1 --prompt-text "<sks> custom prompt for all angles"
```

- **`--skip-cached`**: Skip angles that already have an image under `angle_XXX`.
- **`--force`**: Run Comfy even when a cache exists (use with `--skip-cached` only when you need regeneration semantics).

## Serverless test mode

With ComfyUI already running on port 8188:

```bash
python -m services.multi_angle_ai_service.serverless --test-mode --enable-default --image-url https://example.com/image.png --angle-id 0
```

Optional: `--prompt-text "..."`, `--library-key my_run`.

In test mode, a local filesystem path passed to `--image-url` is uploaded directly to ComfyUI via `/upload/image`, then used as the `LoadImage` input reference.

## Docker build

From repository root:

```bash
bash services/multi_angle_ai_service/deployment/buildspec.sh
```

Set `IMAGE_REPO_URL` / `IMAGE_TAG` as needed. Builder stage excludes `models/` by default (see `builder.dockerignore`); populate models in the image or mount volumes per your ops pattern.

## Shared config (`services/`)

- **`services.constant`**: `LOCAL_INPUT_DIR`, `LOCAL_OUTPUT_DIR`, S3 buckets, `TIMEOUT`. Override via environment variables (see `constant.py`).
- **`services.utils`**: Comfy queue, downloads, S3 upload.

Requires **`boto3`** and AWS credentials in the worker environment when using S3 URLs.

## Camera angles

All definitions live in `camera_angles.json` (`id`, azimuth, elevation, distance, `prompt_text`).
