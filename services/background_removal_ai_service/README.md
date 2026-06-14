# Background removal AI service (RMBG-2.0)

Serverless worker that runs a minimal ComfyUI graph: **LoadImage → RMBG → SaveImage**, using the custom node pack [ComfyUI-RMBG](https://github.com/1038lab/ComfyUI-RMBG) (install under `comfyui/custom_nodes/ComfyUI-RMBG/`). Default model in the workflow is **RMBG-2.0** from [briaai/RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0).

## Layout

| Path | Purpose |
|------|---------|
| `workflows/rmbg2_0_api.json` | ComfyUI **API** prompt (used by `serverless.py`) |
| `serverless.py` | RunPod handler + local `--test-mode` |
| `core.py` | Patch workflow, queue prompt |
| `entrypoint.sh` | Start ComfyUI + serverless (Docker) |
| `deployment/` | `Dockerfile.builder`, `Dockerfile.runtime`, dockerignore, `buildspec.sh` |

## Custom node install (local Comfy)

ComfyUI loads custom nodes from `comfyui/custom_nodes/` only. The app installs required nodes automatically before each Comfy launch; you can also run:

```bash
bash utils/install_custom_nodes.sh
```

Target path: `comfyui/custom_nodes/ComfyUI-RMBG/`

Install that folder’s `requirements.txt` with the same Python ComfyUI uses (see upstream README). The repository root `requirements.txt` still pins shared deps (e.g. `transparent-background`) where useful for Docker; ComfyUI-RMBG’s own requirements cover node-specific packages.

## Input format (serverless)

Same image-ref rules as `image_edit_ai_service` (via `services.utils.normalize_image_urls`):

| Field | Required | Description |
|--------|----------|-------------|
| `image_url` | one of | Single URL, S3 id, or local path |
| `image_urls` | one of | Non-empty list of refs, or a single string (one ref). If both `image_url` and `image_urls` are sent, **`image_urls` wins**. |
| `rmbg` | no | Object of **RMBG** node input overrides (e.g. `sensitivity`, `process_res`, `background`, `model`). The service always wires **`image`** from LoadImage; do not rely on `rmbg.image`. |

Legacy InspyreNet fields (`torchscript_jit`, `use_advanced`, `threshold`) are **ignored** if present.

**Batch:** multiple inputs run sequentially (one Comfy job per image). Response:

- `variations.total_count` — number of results
- `variations.items[i].result.url` — output URL for each input
- `variations.items[i].image_index` — index in the resolved URL list
- `variations.items[i].source_url` — input ref for that item

Single-image jobs still work with `variations.items[0].result.url`. On failure, `error` is set (fail-fast on first bad download/workflow).

## Serverless test mode

ComfyUI on port 8188 with ComfyUI-RMBG loaded:

```bash
python -m services.background_removal_ai_service.serverless --test-mode --enable-default --image-url https://example.com/photo.png
```

**`--image-url`** can also be a **JSON array** of strings (one shell argument), e.g. batch:

```bash
python -m services.background_removal_ai_service.serverless --test-mode --enable-default --image-url "[\"https://example.com/a.png\",\"https://example.com/b.png\"]"
```

When `--image-url` (or items inside `image_urls`) is a local filesystem path in test mode, the service uploads the file to ComfyUI with `/upload/image` and feeds the returned reference to `LoadImage`. S3 staging is no longer needed for local test runs.

## Models

From repository root:

```bash
python utils/download_models.py --background-removal [--hf-token YOUR_TOKEN]
```

This downloads **RMBG-2.0** into `models/RMBG/RMBG-2.0` (layout expected by ComfyUI-RMBG). Accept the model license on Hugging Face if required; use `HF_TOKEN` when gated.

## Docker build

From repository root:

```bash
bash services/background_removal_ai_service/deployment/buildspec.sh
```

Set `IMAGE_REPO_URL` / `IMAGE_TAG` as needed. The runtime image bakes ComfyUI-RMBG into `comfyui/custom_nodes/` at build time via `install_required_custom_nodes`.

## Shared config

Same as other services: `services.constant`, `services.utils`, AWS/S3 env vars when using cloud URLs.

## Upstream

- [1038lab/ComfyUI-RMBG](https://github.com/1038lab/ComfyUI-RMBG)
- [briaai/RMBG-2.0](https://huggingface.co/briaai/RMBG-2.0)
