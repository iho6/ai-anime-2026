"""Regression tests for SequenceEditor FLF/I2V gallery generation.

This specifically guards against missing imports like
`gallery_item_from_frame_urls` causing a NameError and 502 responses.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from services import logic
from services.character_storage import DEFAULT_STORAGE_ROOT


def _write_dummy_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"dummy")


def test_generate_flf_sequence_calls_gallery_helper(monkeypatch: pytest.MonkeyPatch) -> None:
    char_key = "char_test"
    sequence_name = "seq_test"

    # generate_flf_sequence resolves DEFAULT_STORAGE_ROOT / relPath, so create those files.
    rel_a = "flf_src/frame_000001.png"
    rel_b = "flf_src/frame_000100.png"
    abs_a = (DEFAULT_STORAGE_ROOT / rel_a).resolve()
    abs_b = (DEFAULT_STORAGE_ROOT / rel_b).resolve()
    _write_dummy_file(abs_a)
    _write_dummy_file(abs_b)

    start_index = 0
    end_index = 1

    dummy_manifest = {
        "frames": [
            {"index": start_index, "relPath": rel_a, "kind": "image"},
            {"index": end_index, "relPath": rel_b, "kind": "image"},
        ]
    }

    monkeypatch.setattr(logic, "read_sequence_manifest", lambda *_a, **_k: dummy_manifest)
    monkeypatch.setattr(logic, "_validate_flf_timeline_selection", lambda *_a, **_k: None)

    # Avoid calling FLF2Video service / ComfyUI; just return a plausible frame URL list.
    monkeypatch.setattr(logic, "_run_flf_service", lambda *_a, **_k: [f"http://x/f{i}.png" for i in range(10)])

    calls: list[dict[str, object]] = []

    def fake_gallery_item_from_frame_urls(**kwargs):
        calls.append(kwargs)
        return {"galleryItem": {"id": "gid", "frameSequence": {"sequenceGroupId": "sgid", "strip": []}}}

    monkeypatch.setattr(
        logic,
        "gallery_item_from_frame_urls",
        fake_gallery_item_from_frame_urls,
    )

    out = logic.generate_flf_sequence(
        char_key=char_key,
        sequence_name=sequence_name,
        start_index=start_index,
        end_index=end_index,
        length=49,
        log_cb=None,
    )

    # The core assertion: no NameError, and the helper was invoked with FLF-specific prefix.
    assert out["galleryItem"]["id"] == "gid"
    assert len(calls) == 1
    assert calls[0]["gallery_subdir_prefix"] == "flf"
    assert calls[0]["char_key"] == char_key
    assert calls[0]["sequence_name"] == sequence_name


def test_generate_i2v_sequence_calls_gallery_helper(monkeypatch: pytest.MonkeyPatch) -> None:
    char_key = "char_test"
    sequence_name = "seq_test"

    rel_img = "i2v_src/frame_000001.png"
    abs_img = (DEFAULT_STORAGE_ROOT / rel_img).resolve()
    _write_dummy_file(abs_img)

    frame_index = 0
    dummy_manifest = {"frames": [{"index": frame_index, "relPath": rel_img, "kind": "image"}]}

    monkeypatch.setattr(logic, "read_sequence_manifest", lambda *_a, **_k: dummy_manifest)

    # Validate input points should not block this unit test.
    monkeypatch.setattr(
        logic,
        "_validate_i2v_timeline_single_frame",
        lambda *_a, **_k: None,
    )

    monkeypatch.setattr(
        logic,
        "_run_i2v_service",
        lambda *_a, **_k: [f"http://x/i2v_{i}.png" for i in range(8)],
    )

    calls: list[dict[str, object]] = []

    def fake_gallery_item_from_frame_urls(**kwargs):
        calls.append(kwargs)
        return {"galleryItem": {"id": "igid", "frameSequence": {"sequenceGroupId": "sgid", "strip": []}}}

    monkeypatch.setattr(
        logic,
        "gallery_item_from_frame_urls",
        fake_gallery_item_from_frame_urls,
    )

    out = logic.generate_i2v_sequence(
        char_key=char_key,
        sequence_name=sequence_name,
        frame_index=frame_index,
        length=49,
        width=640,
        height=640,
        positive_prompt="a photo of a woman",
        log_cb=None,
    )

    assert out["galleryItem"]["id"] == "igid"
    assert len(calls) == 1
    assert calls[0]["gallery_subdir_prefix"] == "i2v"

