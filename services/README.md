# Comfy worker services (anime2026)

Shared configuration lives in [`constant.py`](constant.py). Override with environment variables where noted.

| Variable | Purpose |
|----------|---------|
| `AWS_REGION` | Region for S3 clients (default `ap-southeast-2`). |
| `S3_OUTPUT_BUCKET`, `S3_OUTPUT_PREFIX` | Upload destination for generated images. |
| `S3_INPUT_BUCKET`, `S3_INPUT_PREFIX` | Optional download source for `uuid`-style inputs. |
| `S3_PUBLIC_URL_BASE` | Public URL prefix returned after upload (no trailing slash on bucket root; include path prefix if used). |
| `LOCAL_INPUT_DIR`, `LOCAL_OUTPUT_DIR` | Comfy input/output folders relative to the worker cwd. |
| `COMFY_TASK_TIMEOUT` | Seconds to wait for a Comfy prompt (default `300`). |
| `COMFY_PORT` | ComfyUI HTTP port used by the character web UI / `services.logic` subprocesses (default `8188`). |
| `SERVICES_DOWNLOAD_CACHE_FILE` | Path to the newline-delimited download cache JSON. |
| `CONVERT_LOCAL_IMAGE_TO_URL` | If `1` / `true` / `yes`, serverless workers upload **local file paths** in `image_url` / `image_urls` to S3 so `download_input` can fetch them, then **delete** those staging objects after each job (same as `--convert-local-to-url` on the CLI). Does **not** remove final result uploads. |

In local `--test-mode`, image-input services now upload local filesystem paths directly to ComfyUI via `POST /upload/image` and pass the returned input reference into `LoadImage`. This avoids temporary S3 staging for local test runs.

Subpackages: `multi_angle_ai_service`, `image_edit_ai_service`, `anime_img_gen_ai_service`, `pose_keypoint_ai_service`, `background_removal_ai_service`, `flf2video_ai_service`, `img2video_ai_service` — each has its own `README.md` and `serverless.py` entrypoint where applicable. Local-only utilities: `noise_generator_service` (Gaussian noise PNGs; see its `README.md`, no serverless).

## Model download flags

From repository root:

```bash
python utils/download_models.py --multi-angle
python utils/download_models.py --image-edit
python utils/download_models.py --anime-gen
python utils/download_models.py --background-removal
python utils/download_models.py --pose-keypoint
python utils/download_models.py --flf-lightning
python utils/download_models.py --img2video-hunyuan-15
python utils/download_models.py --sound-gen
python utils/download_models.py --music-gen
python utils/download_models.py --all
```

- `--multi-angle` -> `multi_angle_ai_service`
- `--image-edit` -> `image_edit_ai_service`
- `--anime-gen` -> `anime_img_gen_ai_service`
- `--pose-keypoint` -> `pose_keypoint_ai_service`
- `--background-removal` -> `background_removal_ai_service` (RMBG-2.0 into `models/RMBG/RMBG-2.0`)
- `--flf-lightning` -> `flf2video_ai_service`
- `--img2video-hunyuan-15` -> `img2video_ai_service` (Hunyuan Video 1.5 720p I2V)
- `--sound-gen` -> `sound_gen_ai_service` (Stable Audio Open 1.0)
- `--music-gen` -> `music_gen_ai_service` (ACE-Step 1.5 turbo)
- `--all` -> runs all model-based service downloads together (deduplicates repeated destination paths)

### Motion reference / SMPL-X body model (KiMoD)

KiMoD motion generation (`motion_ref_gen_ai_service`) downloads its **checkpoint** from Hugging Face at runtime. The **SMPL-X body template** used to skin the white mesh viewer is separate — it lives in git as a licensed asset:

```text
storage/body_models/smplx/SMPLX_NEUTRAL.npz   (~104 MB, Git LFS)
```

After `git pull` on SSH / RunPod, fetch LFS objects once per machine (and after pulls that touch this file):

```bash
git lfs install
git lfs pull
ls -lh storage/body_models/smplx/SMPLX_NEUTRAL.npz   # should be ~104 MB, not a tiny pointer
```

Smoke test (requires kimodo + GPU/CPU env as for normal generation):

```bash
python -m services.motion_ref_gen_ai_service.serverless --inspect-smplx --prompt "a person walks forward"
```

Worker health includes `smplx_ready` on `GET /health` (port 8766 by default). Override asset location with `SMPLX_MODEL_DIR` (parent of the `smplx/` folder).

## Character web UI (React + FastAPI)

The Next.js frontend and FastAPI API live under [`services/ui/`](ui/): `frontend/` and `api/`. Shared disk and subprocess orchestration is in [`logic.py`](logic.py) at the `services` package root (`import services.logic`).

Character files are stored under:

- `storage/characters/<character_name>/` (tracked in git by default). Set **`ANIME_STORAGE_ROOT`** to an absolute path to keep data outside the repo. If you previously used `services/STORAGE/`, rename that folder to `storage` or point `ANIME_STORAGE_ROOT` at the old location.

Layout (written by `services.logic` when the UI runs jobs):

- `base.<ext>` (character base icon)
- `poses/` — **flat** gallery: only image files at this level. **Segmented names:** `pose_000.<ext>` is synced from `base`; new tiles are `pose_NNN.<ext>`; multi-angle outputs append `_angle_MMM` (camera id); AI edits append `_edit_KKK` (three digits, chainable). Legacy `angle_*` / `*_edited_*` names are rewritten by **v3** migration. Optional `starting_image.<ext>` is supported but migrated away when v3 runs.
- `expressions/` — same pattern with `expr_000` / `expr_NNN` / `_angle_MMM` / `_edit_KKK`.
- `dataset/<dataset_folder>/` — dataset exports (`manifest.json`, etc.)

**Gallery migrations (run automatically on load, or via CLI):**

1. **v1 — `*_multi_angle/` lift:** older data may live under `poses/<label>/<label>_multi_angle/`. The app migrates these on first use. To run the v1 step across storage in one go:

```bash
python utils/migrate_gallery_flat.py --dry-run   # preview
python utils/migrate_gallery_flat.py             # lift files into parent folders
```

2. **v2 — flat galleries:** lifts `poses/<folder>/` and `expressions/<folder>/` into the respective roots, rewrites `pimg:` / `eimg:` item ids to the logical `flat` bucket, and sets `gallery_layout_v2` in `gallery_ui_state.json`:

```bash
python utils/migrate_gallery_layout_v2.py --dry-run
python utils/migrate_gallery_layout_v2.py
python utils/migrate_gallery_layout_v2.py --char-key MyCharacter
```

If `gallery_ui_state.json` says a migration ran but your tree was restored from backup, use `--reset-gallery-state` (v1 tool) or `--reset-layout-v2` (v2 tool) per character to re-run—tile ordering in the UI may change.

3. **v3 — segmented filenames:** renames legacy flat-gallery files to `pose_*` / `expr_*` grammar and sets `gallery_filename_v3` (runs automatically after v2 when loading a character). CLI:

```bash
python utils/migrate_gallery_filenames_v3.py
python utils/migrate_gallery_filenames_v3.py --char-key MyCharacter
python utils/migrate_gallery_filenames_v3.py --reset-filename-v3 --char-key MyCharacter
```

**Comfy:** set `COMFY_PORT` (default `8188`) so `services.logic` subprocess calls hit the right ComfyUI instance.

Run the API from the repository root (after `pip install -r requirements.txt` and `pip install -r services/ui/api/requirements.txt` as needed):

```bash
python -m uvicorn services.ui.api.main:app --host 127.0.0.1 --port 8010
```

Run the frontend from `services/ui/frontend` (see that folder’s `README.md`; typically `npm install` and `npm run dev`).

### Sequence editor: FLF (“Frame Sequence”)

In **Dataset → sequence → Sequence** editor, select a **contiguous** timeline span where **only the first and last** frames hold images and **slots in between have no keyframes** (empty gap). Right‑click the timeline and choose **Generate FLF video**, confirm **length** (default 33). The API runs `services.flf2video_ai_service.serverless` in test mode against **ComfyUI** on `COMFY_PORT` (default `8188`). Output PNGs are stored under `sequence/<name>/gallery/flf_*` and show as a **folder** gallery tile with an editable **Frame Sequence** (main strip, optional empty holds, parallel hidden lane). Drag that tile onto the timeline to place frames and empty timing while preserving strip spacing; grouped cells show a **Frame Sequence** outline.
