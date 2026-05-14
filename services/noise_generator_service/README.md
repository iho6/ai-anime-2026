# Noise generator service (local)

Generates **PNG** images of **Gaussian noise** with a chosen width and height. Use as a **backdrop** behind RGBA cutouts so LoRA training does not lock onto structured backgrounds.

- **No ComfyUI, S3, or RunPod** — writes directly to disk.
- **Dependencies:** `numpy`, `Pillow` (see repository root `requirements.txt`).

## CLI

From the repository root:

```bash
python -m services.noise_generator_service --width 1024 --height 1024 --out backdrop.png
python -m services.noise_generator_service --width 512 --height 512 --out n.png --seed 42 --std 40
```

| Flag | Description |
|------|-------------|
| `--width`, `--height` | Positive integers (max 16384 each) |
| `--out` | Output PNG path |
| `--seed` | Optional RNG seed for reproducibility |
| `--channels` | `1` or `3` (default `3`). Single channel is broadcast to RGB. |
| `--mean`, `--std` | Gaussian parameters on a 0–255 scale (defaults `127.5`, `25.0`) |
| `--grayscale` | Draw one plane and broadcast to RGB |

## Programmatic use

```python
from services.noise_generator_service import gaussian_noise_image, save_noise_png

img = gaussian_noise_image(512, 512, seed=0, std=30.0)
img.save("noise.png", format="PNG")

save_noise_png("out/noise.png", 1024, 1024, seed=1, grayscale=True)
```

## Compositing (downstream)

1. Open the noise PNG as the base **RGB** image.
2. Open the character cutout **RGBA**.
3. Paste with alpha: `base.paste(character, (0, 0), character)` (Pillow).
4. Save the training sample (prefer lossless PNG for this step if desired).

## Layout

| File | Role |
|------|------|
| `generate.py` | NumPy noise + Pillow `RGB` image |
| `__main__.py` | Command-line entry |
| `__init__.py` | Public exports |
