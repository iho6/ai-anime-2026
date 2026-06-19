"""Tests for kimodo text encoder headless overlay."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from services.kimodo_setup import apply_kimodo_patches


def _load_text_encoder_script(kimodo_dir: Path):
    scripts_dir = kimodo_dir / "kimodo" / "scripts"
    theme_path = scripts_dir / "gradio_theme.py"
    theme_path.write_text(
        "def get_gradio_theme():\n    return None, ''\n",
        encoding="utf-8",
    )
    script_path = scripts_dir / "run_text_encoder_server.py"

    kimodo_pkg = types.ModuleType("kimodo")
    scripts_pkg = types.ModuleType("kimodo.scripts")
    scripts_pkg.__path__ = [str(scripts_dir)]

    theme_spec = importlib.util.spec_from_file_location(
        "kimodo.scripts.gradio_theme",
        theme_path,
    )
    assert theme_spec and theme_spec.loader
    theme_mod = importlib.util.module_from_spec(theme_spec)
    theme_spec.loader.exec_module(theme_mod)

    model_mod = types.ModuleType("kimodo.model")
    model_mod.resolve_target = lambda _target: mock.MagicMock()

    fake_gr = mock.MagicMock()
    fake_gr.Progress = mock.MagicMock()

    modules = {
        "gradio": fake_gr,
        "numpy": mock.MagicMock(),
        "kimodo": kimodo_pkg,
        "kimodo.scripts": scripts_pkg,
        "kimodo.scripts.gradio_theme": theme_mod,
        "kimodo.model": model_mod,
    }
    with mock.patch.dict(sys.modules, modules):
        spec = importlib.util.spec_from_file_location(
            "kimodo.scripts.run_text_encoder_server",
            script_path,
            submodule_search_locations=[str(scripts_dir)],
        )
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = "kimodo.scripts"
        spec.loader.exec_module(mod)
    return mod


class KimodoTextEncoderHeadlessTests(unittest.TestCase):
    def test_headless_arg_parses_after_apply(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()
            (kimodo_dir / "kimodo" / "scripts").mkdir(parents=True)
            apply_kimodo_patches(kimodo_dir)

            script_path = kimodo_dir / "kimodo" / "scripts" / "run_text_encoder_server.py"
            source = script_path.read_text(encoding="utf-8")
            self.assertIn("--headless", source)
            self.assertIn("READY:", source)
            self.assertNotIn("show_api", source)

            mod = _load_text_encoder_script(kimodo_dir)
            args = mod.parse_args(["--headless"])
            self.assertTrue(args.headless)


if __name__ == "__main__":
    unittest.main()
