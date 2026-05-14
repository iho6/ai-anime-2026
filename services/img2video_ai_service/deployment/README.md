# Img2Video Docker deployment (Hunyuan Video 1.5 I2V)

## Models

The [`Dockerfile.runtime`](Dockerfile.runtime) copies the **repository** only. **Hunyuan Video 1.5 and related weights are not baked** into the image (large downloads).

### Option A — Volume mount (recommended)

Pre-download on the host (or a data volume), then mount over Comfy’s model tree inside the container:

```bash
docker run ... -v /path/to/anime2026-models:/anime2026/models ...
```

Filenames and loader types must match the graph in [`../workflows/video_hunyuan_video_1.5_720p_i2v_api_easyCache.json`](../workflows/video_hunyuan_video_1.5_720p_i2v_api_easyCache.json) (UNET, VAE, DualCLIP, CLIP vision, EasyCache, etc.).

### Option B — Download at container start

From `/anime2026` (WORKDIR in the image), with optional Hugging Face token:

```bash
python utils/download_models.py --img2video-hunyuan-15 [--hf-token "$HF_TOKEN"]
```

Or prefetch the full multi-service stack (deduplicates overlapping weights):

```bash
python utils/download_models.py --all [--hf-token "$HF_TOKEN"]
```

Cold start will be slow and requires sufficient disk inside the container.

### Option C — Bake into a custom image (fork)

Add a `RUN` step that downloads the Hunyuan 1.5 I2V stack. Expect **very large** images and long builds.
