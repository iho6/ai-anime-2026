"""Unit tests for PyTorch version helpers (no GPU required)."""

from __future__ import annotations

from services.pytorch_setup import (
    MIN_TORCH_VERSION,
    parse_torch_version,
    torch_version_ok,
)


def test_parse_torch_version_cu_wheel() -> None:
    assert parse_torch_version("2.8.0+cu128") == (2, 8, 0)
    assert parse_torch_version("2.7.1+cu124") == (2, 7, 1)


def test_parse_torch_version_invalid() -> None:
    assert parse_torch_version("") is None
    assert parse_torch_version("bad") is None


def test_min_torch_version_constant() -> None:
    assert MIN_TORCH_VERSION == (2, 8, 0)


def test_torch_version_ok_without_torch(monkeypatch) -> None:
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "torch":
            raise ImportError("no torch")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    assert torch_version_ok() is False
