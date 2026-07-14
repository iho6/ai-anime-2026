"""Tests for preview proxy sizing helpers."""

from __future__ import annotations

from services.timeline_proxy import PROXY_MAX_H, _scaled_even


def test_scaled_even_downscales_tall_source():
    w, h = _scaled_even(1920, 1080)
    assert h == PROXY_MAX_H
    assert w % 2 == 0 and h % 2 == 0
    # Aspect ratio preserved (16:9 -> ~853x480, rounded to even).
    assert abs(w / h - 1920 / 1080) < 0.02


def test_scaled_even_leaves_small_source_but_makes_even():
    w, h = _scaled_even(641, 361)
    assert h <= PROXY_MAX_H
    assert w % 2 == 0 and h % 2 == 0


def test_scaled_even_guards_zero():
    assert _scaled_even(0, 0) == (2, 2)
