# Kimodo overlays

The `kimodo/` directory is an upstream git submodule. Build and runtime fixes cannot be
committed inside that submodule from this repo.

These files mirror paths under `kimodo/` and are copied in automatically by
`services.kimodo_setup.apply_kimodo_patches` (alias: `apply_kimodo_cmake_patches`).

## When overlays are applied

1. **Editable pip install** — `ensure_kimodo_installed` / `pip_install_kimodo_editable`
2. **Motion ref generation runtime** — before spawning the text encoder subprocess
   (`text_encoder_worker.ensure_text_encoder`) and before the motion worker subprocess
   (`serverless.ensure_worker`), so motion-gen works after `git submodule update` without
   re-running pip.

## Overlay files

| Overlay | Purpose |
|---------|---------|
| `build_cmake.py`, `setup.py`, `MANIFEST.in`, `MotionCorrection/setup.py` | CMake builds MotionCorrection against the active venv Python |
| `kimodo/scripts/run_text_encoder_server.py` | `--headless` Gradio API server (`READY:{port}`, `api_name="DemoWrapper"`) |
| `kimodo/assets/__init__.py` | Path helpers when both `assets.py` and `assets/` exist upstream |

`apply_kimodo_patches` also **removes** `kimodo/assets.py` after copying
`kimodo/assets/__init__.py` (the file and package directory cannot coexist).

## Editing rule

Edit overlays here under `patches/kimodo/`, not inside the `kimodo/` submodule.
Re-applying overlays is idempotent (safe to run multiple times).

## Install flow

PEP 660 editable metadata from `pyproject.toml` registers the `kimodo` package but not
`motion_correction` (that mapping lives only in `setup.py`). Use a two-step install
(same pattern as upstream Docker):

1. **Step A — kimodo Python package only**

   ```bash
   SKIP_MOTION_CORRECTION_IN_SETUP=1 pip install -e kimodo --no-build-isolation --no-deps
   ```

2. **Step B — motion_correction C extension**

   ```bash
   pip install -e kimodo/MotionCorrection --no-build-isolation --no-deps
   ```

`ensure_kimodo_installed` / `pip_install_kimodo_editable` run both steps automatically.
Do not use `--force-reinstall` on kimodo — it re-resolves dependencies and can clobber
the CUDA PyTorch wheel installed by `pytorch_setup`.

## MotionCorrection build (fresh clones)

Editable install runs with `--no-build-isolation` so `setup.py` / CMake bind to the
active venv Python (`KIMODO_TARGET_PYTHON`), not pip's isolated build interpreter.
The compiled `_motion_correction*.so` is a **local build artifact** under
`kimodo/MotionCorrection/python/motion_correction/` — it is not committed and is
rebuilt automatically on UI Launch or `pip_install_kimodo_editable()`.
