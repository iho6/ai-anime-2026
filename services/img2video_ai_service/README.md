# Img2Video AI service (Hunyuan Video 1.5 I2V)

Single (or multiple) **start images** → short video(s) using ComfyUI workflow **`video_hunyuan_video_1.5_720p_i2v_api_easyCache`** in `workflows/`. Runtime code loads that API graph; `load_workflows` key is the filename **without** `.json`.

The default graph uses **`CreateVideo` `fps: 24`**, Hunyuan node **`length`** (default **33**), **`width` / `height`** (default **1280**). Optional task fields can override **`steps`**, **`cfg`**, **`seed`**, and **`fps`** (see below).

## Required models

ComfyUI must resolve every loader in [`workflows/video_hunyuan_video_1.5_720p_i2v_api_easyCache.json`](workflows/video_hunyuan_video_1.5_720p_i2v_api_easyCache.json). Examples from that file (exact filenames):

| Role | Example filename in graph |
|------|---------------------------|
| UNet I2V | `hunyuanvideo1.5_720p_i2v_fp16.safetensors` |
| VAE | `hunyuanvideo15_vae_fp16.safetensors` |
| Dual CLIP | `qwen_2.5_vl_7b_fp8_scaled.safetensors`, `byt5_small_glyphxl_fp16.safetensors` |
| CLIP Vision | `sigclip_vision_patch14_384.safetensors` |

If any are missing, `POST /prompt` fails with **Value not in list** on the corresponding loader.

### Download weights

From repository root (large download; set `HF_TOKEN` if Hugging Face returns 401/403):

```bash
python utils/download_models.py --img2video-hunyuan-15 [--hf-token YOUR_TOKEN]
```

Included in `python utils/download_models.py --all` (deduplicated by path with multi-angle / image-edit for `qwen_2.5_vl_7b_fp8_scaled.safetensors`).

**Verify:** restart Comfy, run a smoke test (below).

## RunPod / JSON `input`

- **`image_url`** or **`image_urls`**: ordered list of sources (URLs or paths). Same rules as other services (`normalize_image_urls`). **One Comfy job per image** (no `frames` / pair indices).
- **`length`** (optional): single integer, default **33**.
- **`lengths`** (optional): list or comma-separated string, one per image. If there are **more** values than images, the first *n* are used (**warning** logged). If **fewer**, padded with the last value (or **33**) (**warning** logged).
- **`width`**, **`height`** (optional): integers, default **1280** each.
- **`positive_prompt`**, **`negative_prompt`** (optional): CLIP text encodes (titles contain “Positive” / “Negative” in the workflow).
- **`steps`**, **`cfg`**, **`seed`**, **`fps`** (optional): patch first `BasicScheduler`, `CFGGuider`, `RandomNoise`, and `CreateVideo` in the graph when present.
- **`individual_frames`** (optional): if true, each output video is decoded to PNGs under `output/img2video_frames/…` and the API returns **`frame_urls`** instead of **`url`**. Process default from **`--individual-frames`** or env **`IMG2VIDEO_INDIVIDUAL_FRAMES=1`**.

### Example

```json
{
  "input": {
    "image_urls": ["https://example.com/a.png", "https://example.com/b.png"],
    "lengths": [33, 41],
    "width": 1280,
    "height": 1280,
    "positive_prompt": "subtle motion, hold composition"
  }
}
```

### Response

**Video mode (default):** each result has **`url`** (the generated video).

```json
{
  "created_at": 0,
  "queued_at": 0,
  "results": [
    { "image_index": 0, "length": 33, "url": "..." },
    { "image_index": 1, "length": 41, "url": "..." }
  ],
  "error": null
}
```

**Individual-frames mode:** each result has **`frame_urls`** (ordered PNG URLs) and **no** **`url`**.

On failure, `error` is set and processing stops at the first failing image.

## Local `--test-mode`

With ComfyUI listening (e.g. port 8188):

```bash
python -m services.img2video_ai_service.serverless --test-mode --enable-default \
  --image-url "./a.png" \
  --length 33
```

Multiple images:

```bash
python -m services.img2video_ai_service.serverless --test-mode --enable-default \
  --image-url '["./a.png","./b.png"]' \
  --length 33,41
```

Optional: `--positive-prompt`, `--negative-prompt`, `--width`, `--height`, `--convert-local-to-url`, `--individual-frames`.

## Docker

From repo root:

```bash
bash services/img2video_ai_service/deployment/buildspec.sh
```

Container entrypoint: `services/img2video_ai_service/entrypoint.sh`  
Default CMD: `--enable-img2video --serverless`

The runtime image **does not** bundle Hunyuan weights. Mount a volume over `/anime2026/models` or download models before serving (see [`deployment/README.md`](deployment/README.md)).

## Files

| File | Role |
|------|------|
| `core.py` | Patch `HunyuanVideo15ImageToVideo` + linked `LoadImage`, per-image loop, history → URL or PNG `frame_urls` (PyAV) |
| `serverless.py` | RunPod handler + CLI |
| `workflows/*.json` | Comfy API graph |
