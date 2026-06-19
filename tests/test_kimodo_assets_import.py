"""Tests for kimodo.assets import (assets.py vs assets/ directory conflict)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
_KIMODO_SRC = _REPO_ROOT / "kimodo"
if str(_KIMODO_SRC) not in sys.path:
    sys.path.insert(0, str(_KIMODO_SRC))


class KimodoAssetsImportTests(unittest.TestCase):
    def test_skeleton_asset_path_import(self) -> None:
        from kimodo.assets import skeleton_asset_path

        path = skeleton_asset_path("smplx22")
        self.assertIsInstance(path, Path)
        self.assertIn("skeletons", str(path))
        self.assertTrue(str(path).endswith("smplx22") or path.name == "smplx22")


if __name__ == "__main__":
    unittest.main()
