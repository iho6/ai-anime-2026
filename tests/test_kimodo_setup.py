"""Tests for kimodo_setup helpers."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services.kimodo_build_cmake import target_python_executable
from services.kimodo_setup import (
    _kimodo_import_status,
    _kimodo_pip_install_cmd,
    _kimodo_pip_install_env,
    _motion_correction_pip_install_cmd,
    _run_kimodo_editable_install,
    apply_kimodo_cmake_patches,
    apply_kimodo_patches,
    kimodo_build_packages,
    kimodo_cmake_args,
    motion_correction_extension_files,
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

    def test_python_cmake_args_respects_kimodo_target_python(self) -> None:
        import services.kimodo_build_cmake as build_cmake

        with mock.patch.dict(os.environ, {"KIMODO_TARGET_PYTHON": sys.executable}):
            args = build_cmake.python_cmake_args()
        self.assertIn(f"-DPython3_EXECUTABLE={sys.executable}", args)

    def test_target_python_executable_prefers_env_when_valid(self) -> None:
        import services.kimodo_build_cmake as build_cmake

        with mock.patch.dict(os.environ, {"KIMODO_TARGET_PYTHON": sys.executable}):
            self.assertEqual(build_cmake.target_python_executable(), sys.executable)

    def test_kimodo_cmake_args_alias(self) -> None:
        self.assertEqual(kimodo_cmake_args(), python_cmake_args())

    def test_kimodo_pip_install_cmd_uses_no_build_isolation(self) -> None:
        cmd = _kimodo_pip_install_cmd(Path("/tmp/kimodo"))
        self.assertIn("--no-build-isolation", cmd)
        self.assertIn("--no-deps", cmd)
        self.assertIn("-e", cmd)
        self.assertNotIn("--force-reinstall", cmd)
        self.assertNotIn("--no-cache-dir", cmd)

    def test_motion_correction_pip_install_cmd(self) -> None:
        kimodo_dir = Path("/tmp/kimodo")
        cmd = _motion_correction_pip_install_cmd(kimodo_dir)
        self.assertIn("-e", cmd)
        self.assertIn(str(kimodo_dir / "MotionCorrection"), cmd)
        self.assertIn("--no-build-isolation", cmd)
        self.assertIn("--no-deps", cmd)

    def test_kimodo_pip_install_env_sets_skip_motion_correction(self) -> None:
        env = _kimodo_pip_install_env()
        self.assertEqual(env["SKIP_MOTION_CORRECTION_IN_SETUP"], "1")
        self.assertEqual(env["KIMODO_TARGET_PYTHON"], sys.executable)

    def test_run_kimodo_editable_install_runs_two_pip_steps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()
            calls: list[list[str]] = []

            def fake_run(cmd: list[str], **kwargs: object) -> None:
                calls.append(cmd)

            with mock.patch(
                "services.pytorch_setup.ensure_pytorch_stack",
            ) as mock_torch:
                _run_kimodo_editable_install(
                    kimodo_dir,
                    run_command=fake_run,
                )
            self.assertEqual(len(calls), 2)
            self.assertIn(str(kimodo_dir), calls[0])
            self.assertIn("MotionCorrection", calls[1][calls[1].index("-e") + 1])
            mock_torch.assert_called_once()

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
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()
            apply_kimodo_cmake_patches(kimodo_dir)
            self.assertTrue((kimodo_dir / "build_cmake.py").is_file())
            setup_text = (kimodo_dir / "setup.py").read_text(encoding="utf-8")
            self.assertIn("python_cmake_args", setup_text)
            self.assertTrue((kimodo_dir / "MotionCorrection" / "setup.py").is_file())
            cmake_text = (kimodo_dir / "build_cmake.py").read_text(encoding="utf-8")
            self.assertIn("KIMODO_TARGET_PYTHON", cmake_text)

    def test_apply_kimodo_patches_copies_runtime_overlays(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()
            apply_kimodo_patches(kimodo_dir)
            encoder = kimodo_dir / "kimodo" / "scripts" / "run_text_encoder_server.py"
            self.assertTrue(encoder.is_file())
            self.assertIn("--headless", encoder.read_text(encoding="utf-8"))
            self.assertTrue((kimodo_dir / "kimodo" / "assets" / "__init__.py").is_file())

    def test_apply_kimodo_patches_removes_conflicting_assets_py(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()
            assets_py = kimodo_dir / "kimodo" / "assets.py"
            assets_py.parent.mkdir(parents=True, exist_ok=True)
            assets_py.write_text("# stale module\n", encoding="utf-8")
            apply_kimodo_patches(kimodo_dir)
            self.assertFalse(assets_py.is_file())
            self.assertTrue((kimodo_dir / "kimodo" / "assets" / "__init__.py").is_file())

    def test_kimodo_import_status_reports_missing_extension(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            pkg_dir = (
                kimodo_dir
                / "MotionCorrection"
                / "python"
                / "motion_correction"
            )
            pkg_dir.mkdir(parents=True)
            (pkg_dir / "__init__.py").write_text("from ._motion_correction import *\n", encoding="utf-8")

            ok, status = _kimodo_import_status(kimodo_dir)
            self.assertFalse(ok)
            self.assertIn("missing", status)
            self.assertIn("_motion_correction*.so", status)
            self.assertEqual(motion_correction_extension_files(kimodo_dir), [])


if __name__ == "__main__":
    unittest.main()
