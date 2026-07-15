# Wan 2.2 Native Text-to-Video

Generates video directly from text with Wan 2.2 14B T2V Lightning through the
shared ComfyUI server. Reference generation uses 640×640, 49 frames, and 16 FPS.
No image or I2V conditioning is used.

Install the model bundle:

```bash
python utils/download_models.py --wan-t2v-lightning
```

The two FP8 diffusion experts and two LightX2V LoRAs require roughly 30 GB of
additional disk space. The downloader reuses an existing Wan UMT5 encoder and
VAE when present.

Local smoke run:

```bash
python -m services.t2v_ai_service.serverless \
  --test-mode --enable-default --default-port 8188 \
  --prompt "an anime character walking through falling snow" \
  --width 640 --height 640 --length 49 --fps 16
```

Use `--individual-frames` when the caller needs ordered frame URLs instead of
the encoded ComfyUI video.
