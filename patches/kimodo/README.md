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

## Updating Kimodo (opt-in only)

Kimodo is **never updated automatically**. The default install path early-returns once
`kimodo` imports, so a stale clone is kept as-is across launches.

Multi-segment motion generation needs Kimodo **>= 2026-04-24** (the "improved
multi-prompt generation" release). The motion worker logs the installed commit on load
and fails fast if the sequential multi-prompt API (`Kimodo._multiprompt` /
`num_transition_frames`) is missing.

To update, set `KIMODO_GIT_UPDATE=1` and re-run Launch. `ensure_kimodo_installed` then:

1. `git fetch` + `git pull --ff-only` in `kimodo/` (`update_kimodo_repo`)
2. re-apply overlays (`apply_kimodo_patches`)
3. run the same guarded editable install (`--no-deps` kimodo, `--no-deps`
   MotionCorrection, `-r kimodo-requirements.txt`, then `ensure_pytorch_stack()` last)
4. verify in a fresh subprocess (`_subprocess_import_status`)

`--ff-only` makes a dirty or diverged checkout fail loudly rather than producing a bad
merge. With the flag unset, install behavior is unchanged.

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

`kimodo/` is committed as a gitlink with no `.gitmodules`, so a fresh `git clone` leaves
it empty. Both entry points clone `nv-tlabs/kimodo` at runtime (`_ensure_kimodo_repo`)
when `kimodo/` lacks `setup.py`/`pyproject.toml`.

Full install order (`_run_kimodo_editable_install`):

1. editable `kimodo` (`--no-deps`)
2. editable `kimodo/MotionCorrection` (`--no-deps`)
3. `pip install -r kimodo-requirements.txt` (kimodo's runtime deps, with transitive resolution)
4. `ensure_pytorch_stack()` torch guard last (restores cu128 if a dep shifted torch)

`kimodo-requirements.txt` holds only the kimodo deps that are NOT in repo-root
`requirements.txt` (hydra-core, omegaconf, peft, gradio, gradio-client, trimesh,
scenepic, bvhio). It is intentionally **disjoint** from `requirements.txt` and excludes
`torch*` and `transformers` so app/Comfy dep versions are not duplicated or churned.
Because callers early-return when `kimodo_importable()` is true, this whole step
(including the deps install) runs only until kimodo imports successfully — it is not
re-run on later launches.

The install is verified in a **fresh subprocess** (`_subprocess_import_status`), not
in-process: editable installs register packages via `.pth` files that `site.py` reads
only at interpreter startup, so a package installed into the already-running process is
not importable there until a new interpreter starts (e.g. the worker subprocesses).

## MotionCorrection build (fresh clones)

Editable install runs with `--no-build-isolation` so `setup.py` / CMake bind to the
active venv Python (`KIMODO_TARGET_PYTHON`), not pip's isolated build interpreter.
The compiled `_motion_correction*.so` is a **local build artifact** under
`kimodo/MotionCorrection/python/motion_correction/` — it is not committed and is
rebuilt automatically on UI Launch or `pip_install_kimodo_editable()`.
