"""Tests for kimodo_setup helpers."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

from services.kimodo_setup import (
    apply_kimodo_cmake_patches,
    apply_kimodo_patches,
    kimodo_build_packages,
    kimodo_cmake_args,
    python_cmake_args,
    python_dev_headers_ready,
    require_python_dev_headers,
)


class KimodoSetupTests(unittest.TestCase):
    def test_kimodo_build_packages_matches_interpreter(self) -> None:
        py_tag = f"{sys.version_info.major}.{sys.version_info.minor}"
        self.assertEqual(
            kimodo_build_packages(),
            ["cmake", "build-essential", f"python{py_tag}-dev"],
        )

    def test_python_cmake_args_include_venv_python(self) -> None:
        args = python_cmake_args()
        self.assertIn(f"-DPython3_EXECUTABLE={sys.executable}", args)
        self.assertIn(f"-DPYTHON_EXECUTABLE={sys.executable}", args)
        self.assertIn("-DPython3_FIND_UNVERSIONED_NAMES=OFF", args)
        include_arg = next(a for a in args if a.startswith("-DPython3_INCLUDE_DIR="))
        self.assertTrue(include_arg.endswith("=") is False)

    def test_kimodo_cmake_args_alias(self) -> None:
        self.assertEqual(kimodo_cmake_args(), python_cmake_args())

    def test_python_dev_headers_ready_is_bool(self) -> None:
        self.assertIsInstance(python_dev_headers_ready(), bool)

    def test_require_python_dev_headers_raises_when_missing(self) -> None:
        import services.kimodo_build_cmake as build_cmake

        with mock.patch.object(build_cmake, "python_dev_headers_ready", return_value=False):
            with self.assertRaises(RuntimeError) as ctx:
                require_python_dev_headers()
        self.assertIn("Python development headers missing", str(ctx.exception))
        self.assertIn("python", str(ctx.exception))

    def test_apply_kimodo_cmake_patches_copies_overlays(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()
            apply_kimodo_cmake_patches(kimodo_dir)
            self.assertTrue((kimodo_dir / "build_cmake.py").is_file())
            setup_text = (kimodo_dir / "setup.py").read_text(encoding="utf-8")
            self.assertIn("python_cmake_args", setup_text)
            self.assertTrue((kimodo_dir / "MotionCorrection" / "setup.py").is_file())

    def test_apply_kimodo_patches_copies_runtime_overlays(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()
            apply_kimodo_patches(kimodo_dir)
            encoder = kimodo_dir / "kimodo" / "scripts" / "run_text_encoder_server.py"
            self.assertTrue(encoder.is_file())
            self.assertIn("--headless", encoder.read_text(encoding="utf-8"))
            self.assertTrue((kimodo_dir / "kimodo" / "assets" / "__init__.py").is_file())

    def test_apply_kimodo_patches_removes_conflicting_assets_py(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()
            assets_py = kimodo_dir / "kimodo" / "assets.py"
            assets_py.parent.mkdir(parents=True, exist_ok=True)
            assets_py.write_text("# stale module\n", encoding="utf-8")
            apply_kimodo_patches(kimodo_dir)
            self.assertFalse(assets_py.is_file())
            self.assertTrue((kimodo_dir / "kimodo" / "assets" / "__init__.py").is_file())


if __name__ == "__main__":
    unittest.main()
