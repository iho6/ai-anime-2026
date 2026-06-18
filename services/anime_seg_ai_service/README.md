# Anime Segmentation Service

Standalone PyTorch background removal for **anime characters**, using vendored [SkyTNT/anime-segmentation](https://github.com/SkyTNT/anime-segmentation) (Apache-2.0).

## Model

Download the default checkpoint (`isnetis.ckpt`):

```bash
python utils/download_models.py --anime-seg
```

Stored at `models/anime_seg/isnetis.ckpt` (from [Hugging Face skytnt/anime-seg](https://huggingface.co/skytnt/anime-seg)).

## Test mode

```bash
python -m services.anime_seg_ai_service.serverless --test-mode --image-url path/to/image.png
```

Optional options JSON:

```bash
python -m services.anime_seg_ai_service.serverless --test-mode \
  --image-url path/to/image.png \
  --anime-seg-json '{"mask_threshold":0.45,"mask_grow_px":2}'
```

## Options

| Field | Default | Description |
|-------|---------|-------------|
| `net` | `isnet_is` | Model architecture |
| `img_size` | `1024` | Inference square size |
| `mask_threshold` | `0.5` | Binarize soft mask (lower = more foreground) |
| `mask_grow_px` | `0` | Dilate alpha mask |
| `mask_blur_px` | `0` | Blur alpha mask |
| `fp32` | `false` | Disable AMP |

## Vendor

Upstream code lives in `vendor/anime_segmentation/` (git clone of SkyTNT/anime-segmentation).
