"""Tests for kimodo_setup helpers."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from services.kimodo_build_cmake import target_python_executable
import services.kimodo_setup as kimodo_setup
from services.kimodo_setup import (
    _KIMODO_REQUIREMENTS,
    _ensure_kimodo_repo,
    _kimodo_import_status,
    _kimodo_pip_install_cmd,
    _kimodo_pip_install_env,
    _kimodo_requirements_install_cmd,
    _motion_correction_pip_install_cmd,
    _run_git_clone,
    _run_kimodo_editable_install,
    _subprocess_import_status,
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

    def test_kimodo_requirements_install_cmd(self) -> None:
        cmd = _kimodo_requirements_install_cmd()
        self.assertEqual(cmd[0], sys.executable)
        self.assertIn("-r", cmd)
        self.assertTrue(cmd[-1].endswith("kimodo-requirements.txt"))

    def test_kimodo_requirements_file_disjoint_and_complete(self) -> None:
        text = _KIMODO_REQUIREMENTS.read_text(encoding="utf-8")
        pkgs = [
            ln.split("#", 1)[0].strip()
            for ln in text.splitlines()
            if ln.strip() and not ln.lstrip().startswith("#")
        ]
        names = {p.split(">=")[0].split("==")[0].strip().lower() for p in pkgs}
        for required in (
            "peft", "hydra-core", "omegaconf", "gradio",
            "gradio-client", "trimesh", "scenepic", "bvhio",
        ):
            self.assertIn(required, names)
        self.assertNotIn("torch", names)
        self.assertNotIn("transformers", names)

    def test_run_kimodo_editable_install_runs_three_pip_steps(self) -> None:
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
            self.assertEqual(len(calls), 3)
            self.assertIn(str(kimodo_dir), calls[0])
            # Runtime requirements before MotionCorrection so C-build failure
            # cannot strand the venv without gradio.
            self.assertIn("-r", calls[1])
            self.assertTrue(calls[1][-1].endswith("kimodo-requirements.txt"))
            self.assertIn("MotionCorrection", calls[2][calls[2].index("-e") + 1])
            mock_torch.assert_called_once()

    def test_ensure_kimodo_runtime_deps_skips_when_gradio_present(self) -> None:
        run = mock.Mock()
        with mock.patch.object(kimodo_setup, "kimodo_runtime_deps_ready", return_value=True):
            kimodo_setup.ensure_kimodo_runtime_deps(run_command=run)
        run.assert_not_called()

    def test_ensure_kimodo_runtime_deps_installs_when_gradio_missing(self) -> None:
        calls: list[list[str]] = []

        def fake_run(cmd: list[str], **kwargs: object) -> None:
            calls.append(cmd)

        with mock.patch.object(kimodo_setup, "kimodo_runtime_deps_ready", return_value=False):
            kimodo_setup.ensure_kimodo_runtime_deps(run_command=fake_run)
        self.assertEqual(len(calls), 1)
        self.assertIn("-r", calls[0])
        self.assertTrue(calls[0][-1].endswith("kimodo-requirements.txt"))

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

            with mock.patch.object(
                kimodo_setup,
                "_subprocess_import_status",
                return_value=(True, ["kimodo: import OK", "motion_correction: import OK"]),
            ):
                ok, status = _kimodo_import_status(kimodo_dir)
            self.assertFalse(ok)
            self.assertIn("missing", status)
            self.assertIn("_motion_correction", status)
            self.assertEqual(motion_correction_extension_files(kimodo_dir), [])

    def test_motion_correction_extension_files_finds_pyd(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            pkg_dir = kimodo_dir / "MotionCorrection" / "python" / "motion_correction"
            pkg_dir.mkdir(parents=True)
            pyd = pkg_dir / "_motion_correction.cp311-win_amd64.pyd"
            pyd.write_bytes(b"")
            found = motion_correction_extension_files(kimodo_dir)
            self.assertEqual(found, [pyd])

            with mock.patch.object(
                kimodo_setup,
                "_subprocess_import_status",
                return_value=(True, ["kimodo: import OK", "motion_correction: import OK"]),
            ):
                ok, status = _kimodo_import_status(kimodo_dir)
            self.assertTrue(ok)
            self.assertIn(pyd.name, status)
    def test_kimodo_import_status_fails_when_subprocess_import_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            pkg_dir = kimodo_dir / "MotionCorrection" / "python" / "motion_correction"
            pkg_dir.mkdir(parents=True)
            (pkg_dir / "_motion_correction.cpython-311-x86_64-linux-gnu.so").write_bytes(b"")

            with mock.patch.object(
                kimodo_setup,
                "_subprocess_import_status",
                return_value=(False, ["motion_correction: import failed (ImportError: boom)"]),
            ):
                ok, status = _kimodo_import_status(kimodo_dir)
            self.assertFalse(ok)
            self.assertIn("import failed", status)
            self.assertIn("_motion_correction.cpython-311-x86_64-linux-gnu.so", status)

    def test_subprocess_import_status_uses_neutral_cwd_and_fresh_interpreter(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="kimodo: import OK\nmotion_correction: import OK\n", stderr=""
        )
        with mock.patch.object(kimodo_setup.subprocess, "run", return_value=completed) as run:
            ok, lines = _subprocess_import_status()
        self.assertTrue(ok)
        self.assertEqual(lines, ["kimodo: import OK", "motion_correction: import OK"])
        call_args, call_kwargs = run.call_args
        cmd = call_args[0]
        self.assertEqual(cmd[0], sys.executable)
        self.assertIn("-c", cmd)
        self.assertEqual(call_kwargs["cwd"], tempfile.gettempdir())

    def test_subprocess_import_status_returns_false_on_failure(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[], returncode=1,
            stdout="motion_correction: import failed (ModuleNotFoundError: ...)\n",
            stderr="",
        )
        with mock.patch.object(kimodo_setup.subprocess, "run", return_value=completed):
            ok, lines = _subprocess_import_status()
        self.assertFalse(ok)
        self.assertEqual(lines, ["motion_correction: import failed (ModuleNotFoundError: ...)"])

    def test_ensure_kimodo_repo_returns_existing_when_source_present(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            (kimodo_dir / "kimodo" / "model").mkdir(parents=True)
            (kimodo_dir / "setup.py").write_text("# setup\n", encoding="utf-8")
            run = mock.Mock()
            with mock.patch.object(kimodo_setup, "_KIMODO_DIR", kimodo_dir):
                result = _ensure_kimodo_repo(run_command=run)
            self.assertEqual(result, kimodo_dir)
            run.assert_not_called()

    def test_ensure_kimodo_repo_reclones_overlay_only_stub(self) -> None:
        """setup.py from overlays without kimodo/model must not skip clone."""
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()
            (kimodo_dir / "setup.py").write_text("# overlay stub\n", encoding="utf-8")
            (kimodo_dir / "kimodo").mkdir()

            def fake_run(cmd, **kwargs):
                kimodo_dir.mkdir(parents=True, exist_ok=True)
                (kimodo_dir / "setup.py").write_text("# cloned\n", encoding="utf-8")
                (kimodo_dir / "kimodo" / "model").mkdir(parents=True, exist_ok=True)

            run = mock.Mock(side_effect=fake_run)
            with mock.patch.object(kimodo_setup, "_KIMODO_DIR", kimodo_dir):
                result = _ensure_kimodo_repo(run_command=run)
            self.assertEqual(result, kimodo_dir)
            run.assert_called_once()
            self.assertTrue((kimodo_dir / "kimodo" / "model").is_dir())

    def test_ensure_kimodo_repo_clones_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"  # absent -> must clone

            def fake_run(cmd, **kwargs):
                kimodo_dir.mkdir(parents=True, exist_ok=True)
                (kimodo_dir / "setup.py").write_text("# cloned\n", encoding="utf-8")
                (kimodo_dir / "kimodo" / "model").mkdir(parents=True, exist_ok=True)

            run = mock.Mock(side_effect=fake_run)
            with mock.patch.object(kimodo_setup, "_KIMODO_DIR", kimodo_dir):
                result = _ensure_kimodo_repo(run_command=run)
            self.assertEqual(result, kimodo_dir)
            run.assert_called_once()
            cmd = run.call_args[0][0]
            self.assertEqual(cmd[:2], ["git", "clone"])
            self.assertIn("https://github.com/nv-tlabs/kimodo.git", cmd)
            self.assertIn(str(kimodo_dir), cmd)

    def test_run_git_clone_subprocess_fallback_raises_on_failure(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[], returncode=128, stdout="", stderr="fatal: boom"
        )
        with mock.patch.object(kimodo_setup.subprocess, "run", return_value=completed):
            with self.assertRaises(RuntimeError) as ctx:
                _run_git_clone(["git", "clone", "url", "dir"], run_command=None, log_cb=None)
        self.assertIn("Failed to clone kimodo", str(ctx.exception))
        self.assertIn("boom", str(ctx.exception))

    # ── Install-safety: opt-in Kimodo update never runs by default ────────────

    def test_default_install_does_not_update_when_importable(self) -> None:
        """Flag unset + already importable → early return, no git/pull/reinstall."""
        run = mock.Mock()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("KIMODO_GIT_UPDATE", None)
            with mock.patch.object(kimodo_setup, "kimodo_importable", return_value=True), \
                mock.patch.object(kimodo_setup, "update_kimodo_repo") as upd, \
                mock.patch.object(kimodo_setup, "_run_kimodo_editable_install") as reinstall, \
                mock.patch.object(kimodo_setup, "_ensure_kimodo_repo") as ensure_repo:
                kimodo_setup.ensure_kimodo_installed(run_command=run)
        run.assert_not_called()
        upd.assert_not_called()
        reinstall.assert_not_called()
        ensure_repo.assert_not_called()

    def test_git_update_flag_triggers_update_even_when_importable(self) -> None:
        """KIMODO_GIT_UPDATE=1 → update + full reinstall run despite importable."""
        run = mock.Mock()
        order: list[str] = []
        with mock.patch.dict(os.environ, {"KIMODO_GIT_UPDATE": "1"}):
            with mock.patch.object(kimodo_setup, "kimodo_importable", return_value=True), \
                mock.patch.object(kimodo_setup, "ensure_kimodo_build_deps"), \
                mock.patch.object(
                    kimodo_setup, "_ensure_kimodo_repo", return_value=Path("/tmp/kimodo")
                ), \
                mock.patch.object(
                    kimodo_setup, "update_kimodo_repo",
                    side_effect=lambda *a, **k: order.append("update"),
                ) as upd, \
                mock.patch.object(
                    kimodo_setup, "_run_kimodo_editable_install",
                    side_effect=lambda *a, **k: order.append("reinstall"),
                ) as reinstall:
                kimodo_setup.ensure_kimodo_installed(run_command=run)
        upd.assert_called_once()
        reinstall.assert_called_once()
        # Update (pull + re-patch) must precede the editable reinstall.
        self.assertEqual(order, ["update", "reinstall"])

    def test_kimodo_git_update_requested_parses_truthy(self) -> None:
        for val, expected in (("1", True), ("true", True), ("YES", True),
                              ("0", False), ("", False), ("off", False)):
            with mock.patch.dict(os.environ, {"KIMODO_GIT_UPDATE": val}):
                self.assertEqual(kimodo_setup.kimodo_git_update_requested(), expected)

    def test_update_kimodo_repo_pulls_then_patches_in_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            (kimodo_dir / ".git").mkdir(parents=True)
            order: list[str] = []

            def fake_git(cmd: list[str], **kwargs: object) -> None:
                order.append(" ".join(cmd[3:]))  # drop ["git", "-C", dir]

            with mock.patch.object(kimodo_setup, "_run_git_clone", side_effect=fake_git), \
                mock.patch.object(
                    kimodo_setup, "apply_kimodo_patches",
                    side_effect=lambda *a, **k: order.append("patches"),
                ):
                kimodo_setup.update_kimodo_repo(kimodo_dir, run_command=mock.Mock())

            self.assertEqual(
                order,
                ["fetch --all --prune", "pull --ff-only", "patches"],
            )

    def test_update_kimodo_repo_skips_when_not_git(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()  # no .git
            with mock.patch.object(kimodo_setup, "_run_git_clone") as git, \
                mock.patch.object(kimodo_setup, "apply_kimodo_patches") as patches:
                kimodo_setup.update_kimodo_repo(kimodo_dir, run_command=mock.Mock())
            git.assert_not_called()
            patches.assert_not_called()

    def test_sentinel_skips_build_without_force(self) -> None:
        """Warm path: failure sentinel present → raise, no winget/build."""
        run = mock.Mock()
        with tempfile.TemporaryDirectory() as tmp:
            sentinel = Path(tmp) / ".anime2026_kimodo_build_failed"
            sentinel.write_text("prior failure\n", encoding="utf-8")
            with mock.patch.object(
                kimodo_setup, "_kimodo_build_failed_sentinel", return_value=sentinel
            ), mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("ANIME2026_FORCE_KIMODO_BUILD", None)
                os.environ.pop("ANIME2026_SKIP_KIMODO", None)
                os.environ.pop("KIMODO_GIT_UPDATE", None)
                with mock.patch.object(
                    kimodo_setup, "kimodo_importable", return_value=False
                ), mock.patch.object(
                    kimodo_setup, "ensure_kimodo_build_deps"
                ) as deps, mock.patch.object(
                    kimodo_setup, "_ensure_kimodo_repo"
                ) as repo, mock.patch.object(
                    kimodo_setup, "_run_kimodo_editable_install"
                ) as install, mock.patch.object(
                    kimodo_setup, "_resolve_winget_exe"
                ) as winget:
                    with self.assertRaises(RuntimeError) as ctx:
                        kimodo_setup.ensure_kimodo_installed(run_command=run)
        self.assertIn("Previous kimodo build failed", str(ctx.exception))
        deps.assert_not_called()
        repo.assert_not_called()
        install.assert_not_called()
        winget.assert_not_called()
        run.assert_not_called()

    def test_force_ignores_sentinel_and_builds(self) -> None:
        """FORCE=1 retries bootstrap even when sentinel exists."""
        run = mock.Mock()
        with tempfile.TemporaryDirectory() as tmp:
            sentinel = Path(tmp) / ".anime2026_kimodo_build_failed"
            sentinel.write_text("prior failure\n", encoding="utf-8")
            with mock.patch.object(
                kimodo_setup, "_kimodo_build_failed_sentinel", return_value=sentinel
            ), mock.patch.dict(
                os.environ, {"ANIME2026_FORCE_KIMODO_BUILD": "1"}, clear=False
            ):
                os.environ.pop("ANIME2026_SKIP_KIMODO", None)
                os.environ.pop("KIMODO_GIT_UPDATE", None)
                with mock.patch.object(
                    kimodo_setup, "kimodo_importable", side_effect=[False, True]
                ), mock.patch.object(
                    kimodo_setup, "ensure_kimodo_build_deps"
                ) as deps, mock.patch.object(
                    kimodo_setup,
                    "_ensure_kimodo_repo",
                    return_value=Path(tmp) / "kimodo",
                ) as repo, mock.patch.object(
                    kimodo_setup, "_run_kimodo_editable_install"
                ) as install:
                    kimodo_setup.ensure_kimodo_installed(run_command=run)
        deps.assert_called_once()
        repo.assert_called_once()
        install.assert_called_once()
        self.assertFalse(sentinel.is_file())

    def test_skip_kimodo_env_returns_immediately(self) -> None:
        run = mock.Mock()
        with mock.patch.dict(os.environ, {"ANIME2026_SKIP_KIMODO": "1"}):
            with mock.patch.object(
                kimodo_setup, "kimodo_importable"
            ) as imp, mock.patch.object(
                kimodo_setup, "ensure_kimodo_build_deps"
            ) as deps:
                kimodo_setup.ensure_kimodo_installed(run_command=run)
        imp.assert_not_called()
        deps.assert_not_called()
        run.assert_not_called()

    def test_resolve_winget_exe_prefers_working_executable(self) -> None:
        good = r"C:\Tools\winget.exe"
        bad_alias = r"C:\Users\x\AppData\Local\Microsoft\WindowsApps\winget.exe"

        def fake_usable(exe: str) -> bool:
            return exe == good

        with mock.patch.object(
            kimodo_setup.shutil, "which", return_value=bad_alias
        ), mock.patch.object(
            kimodo_setup, "_winget_exe_usable", side_effect=fake_usable
        ), mock.patch.object(
            kimodo_setup.subprocess,
            "run",
            return_value=mock.Mock(
                returncode=0, stdout=good + "\n" + bad_alias + "\n", stderr=""
            ),
        ):
            resolved = kimodo_setup._resolve_winget_exe()
        self.assertEqual(resolved, good)

    def test_build_failure_writes_sentinel(self) -> None:
        run = mock.Mock()
        with tempfile.TemporaryDirectory() as tmp:
            sentinel = Path(tmp) / ".anime2026_kimodo_build_failed"
            with mock.patch.object(
                kimodo_setup, "_kimodo_build_failed_sentinel", return_value=sentinel
            ), mock.patch.dict(
                os.environ, {"ANIME2026_FORCE_KIMODO_BUILD": "1"}, clear=False
            ):
                os.environ.pop("ANIME2026_SKIP_KIMODO", None)
                os.environ.pop("KIMODO_GIT_UPDATE", None)
                with mock.patch.object(
                    kimodo_setup, "kimodo_importable", return_value=False
                ), mock.patch.object(
                    kimodo_setup,
                    "ensure_kimodo_build_deps",
                    side_effect=RuntimeError("cmake boom"),
                ):
                    with self.assertRaises(RuntimeError):
                        kimodo_setup.ensure_kimodo_installed(run_command=run)
            self.assertTrue(sentinel.is_file())
            self.assertIn("cmake boom", sentinel.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
