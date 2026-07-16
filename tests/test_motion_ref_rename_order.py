"""Newest-first motion-ref listing and rename + shots.json rewrite."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from services import motion_ref_storage, motion_shot_storage


def _make_motion(root: Path, key: str, *, mtime: float) -> Path:
    d = root / key
    d.mkdir(parents=True)
    (d / "shots").mkdir()
    (d / "manifest.json").write_text(
        json.dumps({"fps": 30, "frame_count": 10, "segments": []}),
        encoding="utf-8",
    )
    os.utime(d, (mtime, mtime))
    return d


def test_list_motion_ref_keys_newest_first(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(motion_ref_storage, "MOTION_REFS_STORAGE_ROOT", tmp_path)
    t0 = time.time() - 60
    _make_motion(tmp_path, "zzzz_old", mtime=t0)
    _make_motion(tmp_path, "aaaa_mid", mtime=t0 + 20)
    _make_motion(tmp_path, "mmmm_new", mtime=t0 + 40)

    keys = motion_ref_storage.list_motion_ref_keys()
    assert keys == ["mmmm_new", "aaaa_mid", "zzzz_old"]


def test_rename_motion_ref_rewrites_shots_json(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(motion_ref_storage, "MOTION_REFS_STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(motion_shot_storage, "MOTION_REFS_STORAGE_ROOT", tmp_path)

    old_key = "A_person_is_walking"
    new_name = "walking"
    d = _make_motion(tmp_path, old_key, mtime=time.time())
    shot_png = d / "shots" / "abc123.png"
    shot_png.write_bytes(b"png")

    entries = [
        {
            "id": "abc123",
            "motionKey": old_key,
            "frameIndex": 0,
            "azimuth": 0,
            "elevation": 0,
            "relPath": f"motion_refs/{old_key}/shots/abc123.png",
        },
        {
            "id": "other",
            "motionKey": "unrelated",
            "frameIndex": 1,
            "azimuth": 0,
            "elevation": 0,
            "relPath": "motion_refs/unrelated/shots/other.png",
        },
    ]
    (tmp_path / "shots.json").write_text(json.dumps(entries), encoding="utf-8")

    new_key = motion_ref_storage.rename_motion_ref(old_key, new_name)
    assert new_key == "walking"
    assert (tmp_path / "walking" / "manifest.json").is_file()
    assert not (tmp_path / old_key).exists()
    assert (tmp_path / "walking" / "shots" / "abc123.png").is_file()

    rewritten = json.loads((tmp_path / "shots.json").read_text(encoding="utf-8"))
    assert rewritten[0]["motionKey"] == "walking"
    assert rewritten[0]["relPath"] == "motion_refs/walking/shots/abc123.png"
    assert rewritten[1]["motionKey"] == "unrelated"


def test_rename_motion_ref_clash_and_empty(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(motion_ref_storage, "MOTION_REFS_STORAGE_ROOT", tmp_path)
    monkeypatch.setattr(motion_shot_storage, "MOTION_REFS_STORAGE_ROOT", tmp_path)
    _make_motion(tmp_path, "alpha", mtime=time.time())
    _make_motion(tmp_path, "beta", mtime=time.time())

    try:
        motion_ref_storage.rename_motion_ref("alpha", "   ")
        assert False, "expected ValueError for empty name"
    except ValueError as e:
        assert "empty" in str(e).lower()

    try:
        motion_ref_storage.rename_motion_ref("alpha", "beta")
        assert False, "expected ValueError for clash"
    except ValueError as e:
        assert "exists" in str(e).lower()

    assert motion_ref_storage.rename_motion_ref("alpha", "alpha") == "alpha"
