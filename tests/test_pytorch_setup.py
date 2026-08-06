"""Unit tests for PyTorch version helpers (no GPU required)."""

from __future__ import annotations

import pytest

from services.pytorch_setup import (
    MIN_TORCH_VERSION,
    parse_torch_version,
    resolve_torch_profile,
    torch_profile_config,
    torch_stack_needs_install,
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


def test_resolve_torch_profile_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANIME2026_TORCH_PROFILE", raising=False)
    assert resolve_torch_profile() == "cu128"
    name, index, minimum = torch_profile_config()
    assert name == "cu128"
    assert "cu128" in index
    assert minimum == (2, 8, 0)


def test_resolve_torch_profile_rtx40(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANIME2026_TORCH_PROFILE", "rtx40")
    assert resolve_torch_profile() == "rtx40"
    name, index, minimum = torch_profile_config()
    assert name == "rtx40"
    assert "cu124" in index
    assert minimum == (2, 4, 0)


def test_resolve_torch_profile_aliases(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANIME2026_TORCH_PROFILE", "rtx5090")
    assert resolve_torch_profile() == "rtx50"


def test_torch_stack_needs_install_on_profile_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANIME2026_TORCH_PROFILE", "rtx50")
    monkeypatch.setattr(
        "services.pytorch_setup.read_installed_torch_profile",
        lambda: "rtx40",
    )
    monkeypatch.setattr(
        "services.pytorch_setup.torch_version_ok",
        lambda **_kwargs: True,
    )
    assert torch_stack_needs_install() is True


def test_torch_version_ok_without_torch(monkeypatch) -> None:
    import builtins

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "torch":
            raise ImportError("no torch")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    assert torch_version_ok() is False
