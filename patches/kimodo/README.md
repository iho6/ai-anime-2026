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
