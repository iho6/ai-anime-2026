"""Tests for kimodo.assets import (assets.py vs assets/ directory conflict)."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

from services.kimodo_setup import apply_kimodo_patches

_REPO_ROOT = Path(__file__).resolve().parents[1]
_KIMODO_SRC = _REPO_ROOT / "kimodo"


def _load_assets_init(kimodo_dir: Path):
    init_path = kimodo_dir / "kimodo" / "assets" / "__init__.py"
    spec = importlib.util.spec_from_file_location(
        "kimodo_assets_overlay",
        init_path,
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class KimodoAssetsImportTests(unittest.TestCase):
    def test_skeleton_asset_path_import(self) -> None:
        apply_kimodo_patches(_KIMODO_SRC)
        mod = _load_assets_init(_KIMODO_SRC)
        path = mod.skeleton_asset_path("smplx22")
        self.assertIsInstance(path, Path)
        self.assertIn("skeletons", str(path))
        self.assertTrue(str(path).endswith("smplx22") or path.name == "smplx22")

    def test_skeleton_asset_path_after_apply_on_conflicting_tree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kimodo_dir = Path(tmp) / "kimodo"
            kimodo_dir.mkdir()
            assets_pkg = kimodo_dir / "kimodo" / "assets"
            assets_pkg.mkdir(parents=True)
            (assets_pkg / "skeletons").mkdir()
            assets_py = kimodo_dir / "kimodo" / "assets.py"
            assets_py.write_text("# conflicting module\n", encoding="utf-8")

            apply_kimodo_patches(kimodo_dir)
            self.assertFalse(assets_py.is_file())

            mod = _load_assets_init(kimodo_dir)
            path = mod.skeleton_asset_path("smplx22")
            self.assertIsInstance(path, Path)
            self.assertIn("skeletons", str(path))


if __name__ == "__main__":
    unittest.main()
