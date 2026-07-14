"""Tests for the server-side composited preview PNG cache."""

from __future__ import annotations

from services.timeline_preview_frame_cache import TimelinePreviewFrameCache


def test_get_put_roundtrip_and_coloring_key():
    cache = TimelinePreviewFrameCache(max_entries=8)
    cache.put("tl", "c1", 1.0, None, b"plain")
    cache.put("tl", "c1", 1.0, {"r": 200}, b"colored")

    assert cache.get("tl", "c1", 1.0, None) == b"plain"
    assert cache.get("tl", "c1", 1.0, {"r": 200}) == b"colored"
    # Different coloring signature is a distinct entry (miss for unknown sig).
    assert cache.get("tl", "c1", 1.0, {"r": 123}) is None


def test_time_quantized_to_milliseconds():
    cache = TimelinePreviewFrameCache()
    cache.put("tl", "c1", 1.0004, None, b"a")
    # 1.0004 and 1.0 both quantize to 1000ms.
    assert cache.get("tl", "c1", 1.0, None) == b"a"


def test_lru_evicts_oldest():
    cache = TimelinePreviewFrameCache(max_entries=2)
    cache.put("tl", "c1", 0.0, None, b"0")
    cache.put("tl", "c1", 1.0, None, b"1")
    cache.put("tl", "c1", 2.0, None, b"2")  # evicts the 0.0 entry
    assert cache.get("tl", "c1", 0.0, None) is None
    assert cache.get("tl", "c1", 2.0, None) == b"2"


def test_invalidate_clip_and_timeline():
    cache = TimelinePreviewFrameCache()
    cache.put("tl", "c1", 0.0, None, b"x")
    cache.put("tl", "c2", 0.0, None, b"y")
    cache.invalidate_clip("tl", "c1")
    assert cache.get("tl", "c1", 0.0, None) is None
    assert cache.get("tl", "c2", 0.0, None) == b"y"

    cache.put("tl", "c1", 0.0, None, b"x")
    cache.invalidate_timeline("tl")
    assert cache.get("tl", "c1", 0.0, None) is None
    assert cache.get("tl", "c2", 0.0, None) is None
