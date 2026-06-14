"""Tests for KiMoD native SMPL-X skinning helpers."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from services.motion_ref_gen_ai_service.smplx_skinning import (
    bones_from_skeleton,
    ensure_kimodo_smplx_npz,
    kimodo_smplx_asset_ready,
    skin_sequence,
)

# SMPLXSkeleton22 topology (child, parent) — mirrors kimodo/skeleton/definitions.py
_SMPLX22_PARENTS = [
    ("pelvis", None),
    ("left_hip", "pelvis"),
    ("right_hip", "pelvis"),
    ("spine1", "pelvis"),
    ("left_knee", "left_hip"),
    ("right_knee", "right_hip"),
    ("spine2", "spine1"),
    ("left_ankle", "left_knee"),
    ("right_ankle", "right_knee"),
    ("spine3", "spine2"),
    ("left_foot", "left_ankle"),
    ("right_foot", "right_ankle"),
    ("neck", "spine3"),
    ("left_collar", "spine3"),
    ("right_collar", "spine3"),
    ("head", "neck"),
    ("left_shoulder", "left_collar"),
    ("right_shoulder", "right_collar"),
    ("left_elbow", "left_shoulder"),
    ("right_elbow", "right_shoulder"),
    ("left_wrist", "left_elbow"),
    ("right_wrist", "right_elbow"),
]


def _mock_smplx22_skeleton(folder: str = "/tmp/smplx22"):
  names = [n for n, _ in _SMPLX22_PARENTS]
  bone_index = {n: i for i, n in enumerate(names)}
  return SimpleNamespace(
      folder=folder,
      bone_order_names_with_parents=_SMPLX22_PARENTS,
      bone_index=bone_index,
  )


def test_smplx22_bones_from_skeleton():
    skel = _mock_smplx22_skeleton()
    bones = bones_from_skeleton(skel)
    assert len(bones) == 21
    for child, parent in bones:
        assert 0 <= child < 22
        assert 0 <= parent < 22
        assert child != parent


def test_ensure_kimodo_smplx_npz_symlinks_legacy(tmp_path, monkeypatch):
    skel_dir = tmp_path / "smplx22"
    skel_dir.mkdir()
    skel = _mock_smplx22_skeleton(str(skel_dir))

    legacy_parent = tmp_path / "body_models" / "smplx"
    legacy_parent.mkdir(parents=True)
    legacy_npz = legacy_parent / "SMPLX_NEUTRAL.npz"
    legacy_npz.write_bytes(b"fake smplx npz content" * 100)

    import services.motion_ref_gen_ai_service.smplx_skinning as skin_mod

    monkeypatch.setattr(skin_mod, "SMPLX_MODEL_DIR", tmp_path / "body_models")
    monkeypatch.setattr(
        skin_mod,
        "_kimodo_smplx_npz_path",
        lambda: skel_dir / "SMPLX_NEUTRAL.npz",
    )

    resolved = ensure_kimodo_smplx_npz(skel)
    assert resolved == skel_dir / "SMPLX_NEUTRAL.npz"
    assert resolved.is_symlink()
    assert resolved.resolve() == legacy_npz.resolve()
    assert kimodo_smplx_asset_ready()


def test_skin_sequence_dispatches_22_joint_native_without_55_error(monkeypatch):
    """22-joint rotmats with skeleton should not hit the legacy 55-joint error."""
    skel = _mock_smplx22_skeleton()
    T, J = 4, 22
    rot = np.tile(np.eye(3, dtype=np.float32), (T, J, 1, 1))
    pos = np.zeros((T, J, 3), dtype=np.float32)

    called = {"native": False}

    def fake_native(output, skeleton, *, center_xz=None):
        called["native"] = True
        assert skeleton is skel
        verts = np.zeros((T, 100, 3), dtype=np.float32)
        faces = np.zeros((50, 3), dtype=np.int32)
        return verts, faces

    import services.motion_ref_gen_ai_service.smplx_skinning as skin_mod

    monkeypatch.setattr(skin_mod, "skin_sequence_kimodo_native", fake_native)

    out = {"global_rot_mats": rot, "posed_joints": pos}
    verts, faces = skin_sequence(out, skeleton=skel)
    assert called["native"] is True
    assert verts.shape == (T, 100, 3)
    assert faces.shape == (50, 3)


def test_skin_sequence_22_joint_without_skeleton_raises_legacy_error(monkeypatch):
    """Without skeleton, 22-joint rotmats route to legacy path and reject short joint count."""
    T, J = 2, 22
    rot = np.tile(np.eye(3, dtype=np.float32), (T, J, 1, 1))
    out = {"global_rot_mats": rot, "posed_joints": np.zeros((T, J, 3), dtype=np.float32)}

    import services.motion_ref_gen_ai_service.smplx_skinning as skin_mod

    monkeypatch.setattr(skin_mod, "_smplx_available", lambda: True)
    monkeypatch.setattr(
        skin_mod,
        "load_smplx_model",
        lambda *a, **k: SimpleNamespace(faces=np.zeros((1, 3), dtype=np.int32)),
    )

    with pytest.raises(RuntimeError, match="55"):
        skin_sequence(out, skeleton=None)


def test_load_kimodo_smplx_skin_class_without_viser(monkeypatch):
    """Headless loader must not require the viser package."""
    import importlib.util
    import sys

    import services.motion_ref_gen_ai_service.smplx_skinning as skin_mod

    monkeypatch.delitem(sys.modules, "viser", raising=False)

    class FakeSkin:
        def skin(self, *args, **kwargs):
            return None

        faces = None

    def fake_exec_module(mod):
        mod.SMPLXSkin = FakeSkin

    def fake_from_file_location(name, path):
        loader = SimpleNamespace(exec_module=fake_exec_module)
        return SimpleNamespace(loader=loader)

    monkeypatch.setattr(importlib.util, "spec_from_file_location", fake_from_file_location)
    monkeypatch.setattr(importlib.util, "module_from_spec", lambda spec: SimpleNamespace())

    cls = skin_mod._load_kimodo_smplx_skin_class()
    assert cls is FakeSkin
    assert "viser" not in sys.modules
