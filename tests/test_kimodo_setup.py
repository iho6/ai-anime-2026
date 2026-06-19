"""Tests for kimodo_setup helpers."""

from __future__ import annotations

import sys
import unittest

from services.kimodo_setup import (
    kimodo_build_packages,
    kimodo_cmake_args,
    python_dev_headers_ready,
)


class KimodoSetupTests(unittest.TestCase):
    def test_kimodo_build_packages_matches_interpreter(self) -> None:
        py_tag = f"{sys.version_info.major}.{sys.version_info.minor}"
        self.assertEqual(
            kimodo_build_packages(),
            ["cmake", "build-essential", f"python{py_tag}-dev"],
        )

    def test_kimodo_cmake_args_include_venv_python(self) -> None:
        args = kimodo_cmake_args()
        self.assertIn(f"-DPython3_EXECUTABLE={sys.executable}", args)
        self.assertIn(f"-DPYTHON_EXECUTABLE={sys.executable}", args)
        self.assertIn("-DPython3_FIND_UNVERSIONED_NAMES=OFF", args)
        include_arg = next(a for a in args if a.startswith("-DPython3_INCLUDE_DIR="))
        self.assertTrue(include_arg.endswith("=") is False)

    def test_python_dev_headers_ready_is_bool(self) -> None:
        self.assertIsInstance(python_dev_headers_ready(), bool)


if __name__ == "__main__":
    unittest.main()
