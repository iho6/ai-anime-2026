"""Tests for kimodo_setup helpers."""

from __future__ import annotations

import sys
import unittest
from unittest import mock

from services.kimodo_setup import (
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
        import services.kimodo_setup as ks

        with mock.patch.object(ks._build_cmake, "python_dev_headers_ready", return_value=False):
            with self.assertRaises(RuntimeError) as ctx:
                require_python_dev_headers()
        self.assertIn("Python development headers missing", str(ctx.exception))
        self.assertIn("python", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
