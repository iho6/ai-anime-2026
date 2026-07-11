"""Tests for timeline preview decoder cache (LRU / TTL / reuse)."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from services.timeline_preview_cache import TimelinePreviewDecoderCache


@pytest.fixture()
def cache() -> TimelinePreviewDecoderCache:
    return TimelinePreviewDecoderCache(ttl_sec=60.0, max_entries=3)


def _fake_decoder_factory(open_count: list[int]):
    """Build a mock _VideoFrameDecoder that counts constructions."""

    class FakeDecoder:
        def __init__(self, path, clip, log_cb=None):
            open_count[0] += 1
            self.path = path
            self.clip = clip
            self._idx = -1
            self.closed = False

        def frame_at_source_time(self, source_time: float):
            from PIL import Image

            self._idx = int(round(source_time * 24))
            return Image.new("RGBA", (8, 8), (10, 20, 30, 255))

        def close(self):
            self.closed = True

    return FakeDecoder


def test_sequential_forward_requests_reuse_decoder(cache: TimelinePreviewDecoderCache, tmp_path: Path):
    video = tmp_path / "clip.webm"
    video.write_bytes(b"fake")
    clip = {"id": "c1", "type": "video", "coloring": None}
    opens = [0]

    with patch(
        "services.timeline_preview_cache._VideoFrameDecoder",
        _fake_decoder_factory(opens),
    ):
        cache.get_rgba_frame("tl1", clip, video, 0.0)
        cache.get_rgba_frame("tl1", clip, video, 0.1)
        cache.get_rgba_frame("tl1", clip, video, 0.2)

    assert opens[0] == 1


def test_different_clips_get_separate_decoders(cache: TimelinePreviewDecoderCache, tmp_path: Path):
    video = tmp_path / "clip.webm"
    video.write_bytes(b"fake")
    opens = [0]

    with patch(
        "services.timeline_preview_cache._VideoFrameDecoder",
        _fake_decoder_factory(opens),
    ):
        cache.get_rgba_frame("tl1", {"id": "a", "type": "video"}, video, 0.0)
        cache.get_rgba_frame("tl1", {"id": "b", "type": "video"}, video, 0.0)

    assert opens[0] == 2


def test_invalidate_timeline_closes_and_forces_reopen(
    cache: TimelinePreviewDecoderCache, tmp_path: Path
):
    video = tmp_path / "clip.webm"
    video.write_bytes(b"fake")
    clip = {"id": "c1", "type": "video"}
    opens = [0]
    Fake = _fake_decoder_factory(opens)

    with patch("services.timeline_preview_cache._VideoFrameDecoder", Fake):
        cache.get_rgba_frame("tl1", clip, video, 0.0)
        assert opens[0] == 1
        entry = cache._entries[("tl1", "c1")]
        assert not entry.decoder.closed

        cache.invalidate_timeline("tl1")
        assert ("tl1", "c1") not in cache._entries
        assert entry.decoder.closed

        cache.get_rgba_frame("tl1", clip, video, 0.0)
        assert opens[0] == 2


def test_lru_evicts_oldest(cache: TimelinePreviewDecoderCache, tmp_path: Path):
    video = tmp_path / "clip.webm"
    video.write_bytes(b"fake")
    opens = [0]

    with patch(
        "services.timeline_preview_cache._VideoFrameDecoder",
        _fake_decoder_factory(opens),
    ):
        cache.get_rgba_frame("tl1", {"id": "a"}, video, 0.0)
        cache.get_rgba_frame("tl1", {"id": "b"}, video, 0.0)
        cache.get_rgba_frame("tl1", {"id": "c"}, video, 0.0)
        # max_entries=3; inserting d should evict a
        cache.get_rgba_frame("tl1", {"id": "d"}, video, 0.0)

    assert ("tl1", "a") not in cache._entries
    assert ("tl1", "d") in cache._entries
    assert opens[0] == 4


def test_path_change_replaces_decoder(cache: TimelinePreviewDecoderCache, tmp_path: Path):
    v1 = tmp_path / "a.webm"
    v2 = tmp_path / "b.webm"
    v1.write_bytes(b"1")
    v2.write_bytes(b"2")
    clip = {"id": "c1", "type": "video"}
    opens = [0]

    with patch(
        "services.timeline_preview_cache._VideoFrameDecoder",
        _fake_decoder_factory(opens),
    ):
        cache.get_rgba_frame("tl1", clip, v1, 0.0)
        cache.get_rgba_frame("tl1", clip, v2, 0.0)

    assert opens[0] == 2


def test_coloring_applied_via_cache(cache: TimelinePreviewDecoderCache, tmp_path: Path):
    video = tmp_path / "clip.webm"
    video.write_bytes(b"fake")
    clip = {"id": "c1", "type": "video", "coloring": {"r": 200, "g": 100, "b": 100}}
    opens = [0]

    with patch(
        "services.timeline_preview_cache._VideoFrameDecoder",
        _fake_decoder_factory(opens),
    ):
        rgba = cache.get_rgba_frame("tl1", clip, video, 0.0)

    # Fake decoder returns (10, 20, 30, 255); r gain 2.0 → 20
    assert rgba.getpixel((0, 0))[0] == 20
