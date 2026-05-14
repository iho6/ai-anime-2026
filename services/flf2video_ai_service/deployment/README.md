# FLF2Video Docker deployment

## Models

The [`Dockerfile.runtime`](Dockerfile.runtime) copies the **repository** only. **Wan 2.2 FLF lightning weights are not baked** into the image (multi‑tens of GB).

### Option A — Volume mount (recommended)

Pre-download on the host (or a data volume), then mount over Comfy’s model tree inside the container:

```bash
docker run ... -v /path/to/anime2026-models:/anime2026/models ...
```

The mounted tree must include the six files listed under **Required models (lightning)** in [../README.md](../README.md) (`models/text_encoders`, `models/vae`, `models/diffusion_models`, `models/loras`).

### Option B — Download at container start

Run once from `/anime2026` (WORKDIR in the image):

```bash
python utils/download_models.py --flf-lightning [--hf-token "$HF_TOKEN"]
```

Then start Comfy + serverless as in `entrypoint.sh`. Cold start will be slow and requires sufficient disk inside the container.

### Option C — Bake into a custom image (fork)

Add a `RUN` step after copying the repo that invokes `download_models.py --flf-lightning`. Expect **very large** images and long builds.
