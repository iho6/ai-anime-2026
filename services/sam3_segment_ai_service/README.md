# SAM 3.1 segment service

Point- and/or text-prompt segmentation for timeline clips using native ComfyUI `SAM3_Detect` / `SAM3_VideoTrack`.

## Model

`sam3.1_multiplex_fp16.safetensors` in `comfyui/models/checkpoints/` (see `python utils/download_models.py --sam3`).

## Local test

Point prompt:

```bash
python -m services.sam3_segment_ai_service.serverless \
  --test-mode --enable-default \
  --job image_mask \
  --image-url /path/to/image.png \
  --positive-coords '[{"x":100,"y":200}]' \
  --convert-local-to-url
```

Text-only prompt:

```bash
python -m services.sam3_segment_ai_service.serverless \
  --test-mode --enable-default \
  --job image_mask \
  --image-url /path/to/image.png \
  --text-prompt "person" \
  --convert-local-to-url
```

Text + points (masks are unioned):

```bash
python -m services.sam3_segment_ai_service.serverless \
  --test-mode --enable-default \
  --job image_rgba \
  --image-url /path/to/image.png \
  --positive-coords '[{"x":100,"y":200}]' \
  --text-prompt "red car" \
  --convert-local-to-url
```

Jobs: `image_mask`, `image_rgba`, `video_masks`.

At least one positive point **or** a non-empty text prompt is required.
