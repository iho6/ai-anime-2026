"""Tests for timeline video-edit trim → strip hidden sync (mirrors frontend logic)."""

from __future__ import annotations

from typing import Any


def _strip_slot_visible_for_export(slot: dict[str, Any]) -> bool:
    if str(slot.get("kind") or "") != "image":
        return False
    if slot.get("hidden") is True:
        return False
    rel = str(slot.get("relPath") or "").strip()
    return bool(rel)


def _apply_trim_hidden(slot: dict[str, Any], outside: bool) -> dict[str, Any]:
    if outside:
        if slot.get("hidden") is True and slot.get("trimHidden") is not True:
            return slot
        return {**slot, "hidden": True, "trimHidden": True}
    if slot.get("trimHidden") is not True:
        return slot
    out = dict(slot)
    out.pop("hidden", None)
    out.pop("trimHidden", None)
    return out


def sync_trim_hidden_to_frame_sequence(
    frame_sequence: dict[str, Any],
    *,
    in_point: float,
    out_point: float,
    extract_in_point_sec: float = 0.0,
    extract_fps: float = 24.0,
    mp4_aligned: bool = False,
) -> dict[str, Any]:
    """Python mirror of ``syncTrimHiddenToFrameSequence`` in frameSequenceStripUtils.ts."""
    strip = list(frame_sequence.get("strip") or [])
    rate = max(1.0, float(extract_fps))
    mp4_frame = 0
    next_strip: list[dict[str, Any]] = []

    for strip_index, slot in enumerate(strip):
        if str(slot.get("kind") or "") != "image":
            next_strip.append(slot)
            continue
        if mp4_aligned:
            rel = str(slot.get("relPath") or "").strip()
            if not rel or (
                slot.get("hidden") is True and slot.get("trimHidden") is not True
            ):
                next_strip.append(slot)
                continue
            source_sec = mp4_frame / rate
            mp4_frame += 1
            outside = source_sec < in_point or source_sec >= out_point
            next_strip.append(_apply_trim_hidden(slot, outside))
            continue
        source_sec = float(extract_in_point_sec) + strip_index / rate
        outside = source_sec < in_point or source_sec >= out_point
        next_strip.append(_apply_trim_hidden(slot, outside))

    return {
        **frame_sequence,
        "strip": next_strip,
        "hidden": [],
    }


def _image_slot(rel: str, *, hidden: bool = False) -> dict[str, Any]:
    slot: dict[str, Any] = {"kind": "image", "relPath": rel}
    if hidden:
        slot["hidden"] = True
    return slot


def test_linear_trim_hides_outside_range() -> None:
    fps = 24.0
    strip = [_image_slot(f"f{i:03d}.png") for i in range(100)]
    fs = {"sequenceGroupId": "clip1", "strip": strip, "hidden": []}
    synced = sync_trim_hidden_to_frame_sequence(
        fs,
        in_point=2.0,
        out_point=5.0,
        extract_in_point_sec=0.0,
        extract_fps=fps,
    )
    out = synced["strip"]
    for i in range(48):
        assert out[i].get("hidden") is True, f"index {i} should be hidden"
        assert out[i].get("trimHidden") is True, f"index {i} should be trim-hidden"
    for i in range(48, 100):
        assert out[i].get("hidden") is not True, f"index {i} should be visible"


def test_linear_trim_noop_when_range_covers_extract() -> None:
    fps = 24.0
    strip = [_image_slot(f"f{i:03d}.png") for i in range(72)]
    fs = {"sequenceGroupId": "clip1", "strip": strip, "hidden": []}
    synced = sync_trim_hidden_to_frame_sequence(
        fs,
        in_point=0.0,
        out_point=3.0,
        extract_in_point_sec=0.0,
        extract_fps=fps,
    )
    assert synced["strip"] == strip


def test_mp4_aligned_respects_pre_hidden_slots() -> None:
    fps = 24.0
    strip = [
        _image_slot("a.png"),
        _image_slot("b.png", hidden=True),
        _image_slot("c.png"),
        _image_slot("d.png"),
    ]
    fs = {"sequenceGroupId": "clip1", "strip": strip, "hidden": []}
    synced = sync_trim_hidden_to_frame_sequence(
        fs,
        in_point=0.0,
        out_point=10.0,
        extract_fps=fps,
        mp4_aligned=True,
    )
    out = synced["strip"]
    assert out[0].get("hidden") is not True
    assert out[1].get("hidden") is True
    assert out[2].get("hidden") is not True
    assert out[3].get("hidden") is not True


def test_mp4_aligned_trim_hides_visible_frames_outside_range() -> None:
    fps = 24.0
    strip = [_image_slot(f"f{i}.png") for i in range(6)]
    fs = {"sequenceGroupId": "clip1", "strip": strip, "hidden": []}
    synced = sync_trim_hidden_to_frame_sequence(
        fs,
        in_point=1.0 / fps,
        out_point=4.0 / fps,
        extract_fps=fps,
        mp4_aligned=True,
    )
    out = synced["strip"]
    assert out[0].get("hidden") is True
    assert out[0].get("trimHidden") is True
    assert out[1].get("hidden") is not True
    assert out[2].get("hidden") is not True
    assert out[3].get("hidden") is not True
    assert out[4].get("hidden") is True
    assert out[5].get("hidden") is True


def test_trim_expansion_unhides_only_automatic_frames() -> None:
    strip = [
        {**_image_slot("auto.png", hidden=True), "trimHidden": True},
        _image_slot("manual.png", hidden=True),
    ]
    synced = sync_trim_hidden_to_frame_sequence(
        {"sequenceGroupId": "clip1", "strip": strip, "hidden": []},
        in_point=0.0,
        out_point=2.0,
        extract_fps=1.0,
    )
    assert synced["strip"][0].get("hidden") is not True
    assert "trimHidden" not in synced["strip"][0]
    assert synced["strip"][1].get("hidden") is True
