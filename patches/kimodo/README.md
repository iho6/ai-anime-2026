# Kimodo CMake overlays

The `kimodo/` directory is an upstream git submodule. CMake fixes for MotionCorrection
cannot be committed inside that submodule from this repo.

These files are copied into `kimodo/` automatically before `pip install -e kimodo`
(see `services/kimodo_setup.apply_kimodo_cmake_patches`). Edit overlays here, not
inside the submodule, when changing the MotionCorrection build.
