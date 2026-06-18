"""Unit tests for anime seg dependency helpers."""

from __future__ import annotations

from services.anime_seg_setup import anime_seg_importable


def test_anime_seg_importable_is_bool() -> None:
    assert isinstance(anime_seg_importable(), bool)
