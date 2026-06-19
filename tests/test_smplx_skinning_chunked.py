"""Tests for chunked SMPL-X skinning OOM fallback."""

from __future__ import annotations

from types import SimpleNamespace
from unittest import mock

import numpy as np
import pytest
import torch

from services.motion_ref_gen_ai_service import smplx_skinning as skin_mod


def _mock_skeleton(*, device_type: str = "cuda"):
    """CPU-backed skeleton that reports a given device type (no GPU alloc)."""
    neutral = torch.zeros(22, 3)
    parents = torch.arange(22)
    # Patch .device on tensors without moving storage to a broken CUDA stack.
    neutral = mock.MagicMock(wraps=neutral)
    neutral.device = torch.device(device_type)
    neutral.to.return_value = torch.zeros(22, 3)
    parents = mock.MagicMock(wraps=parents)
    parents.to.return_value = torch.arange(22)
    return SimpleNamespace(
        folder="/tmp/smplx22",
        neutral_joints=neutral,
        joint_parents=parents,
        root_idx=0,
        bone_order_names=tuple(f"j{i}" for i in range(22)),
        bone_index={f"j{i}": i for i in range(22)},
        global_rots_to_local_rots=lambda rot: rot,
    )


def _rot_pos(T: int):
    rot = np.tile(np.eye(3, dtype=np.float32), (T, 22, 1, 1))
    pos = np.zeros((T, 22, 3), dtype=np.float32)
    return rot, pos


@pytest.fixture
def skeleton():
    return _mock_skeleton(device_type="cuda")


@pytest.fixture
def patch_chunk_size(monkeypatch):
    def _set(value: int):
        monkeypatch.setattr(skin_mod, "_skin_chunk_frames", lambda: value)

    return _set


def test_proactive_chunk_when_T_exceeds_threshold(skeleton, patch_chunk_size):
    patch_chunk_size(32)
    rot, pos = _rot_pos(100)
    calls: list[int | None] = []

    def fake_skin(rot_np, pos_np, skel, device, chunk_frames):
        calls.append(chunk_frames)
        T = rot_np.shape[0]
        return np.zeros((T, 10, 3), dtype=np.float32), np.zeros((4, 3), dtype=np.int32)

    with mock.patch.object(skin_mod, "_preferred_skin_device", return_value=torch.device("cuda")):
        with mock.patch.object(skin_mod, "_skin_frames_kimodo_native", side_effect=fake_skin):
            skin_mod._skin_kimodo_native_with_fallback(rot, pos, skeleton)

    assert calls == [32]
    assert None not in calls


def test_short_clip_full_batch(skeleton, patch_chunk_size):
    patch_chunk_size(32)
    rot, pos = _rot_pos(16)
    calls: list[int | None] = []

    def fake_skin(rot_np, pos_np, skel, device, chunk_frames):
        calls.append(chunk_frames)
        T = rot_np.shape[0]
        return np.zeros((T, 10, 3), dtype=np.float32), np.zeros((4, 3), dtype=np.int32)

    with mock.patch.object(skin_mod, "_preferred_skin_device", return_value=torch.device("cuda")):
        with mock.patch.object(skin_mod, "_skin_frames_kimodo_native", side_effect=fake_skin):
            skin_mod._skin_kimodo_native_with_fallback(rot, pos, skeleton)

    assert calls == [None]


def test_gpu_oom_full_batch_then_chunked(skeleton, patch_chunk_size):
    patch_chunk_size(32)
    rot, pos = _rot_pos(16)
    calls: list[int | None] = []

    def fake_skin(rot_np, pos_np, skel, device, chunk_frames):
        calls.append(chunk_frames)
        if chunk_frames is None:
            raise torch.cuda.OutOfMemoryError("simulated")
        T = rot_np.shape[0]
        return np.zeros((T, 10, 3), dtype=np.float32), np.zeros((4, 3), dtype=np.int32)

    with mock.patch.object(skin_mod, "_preferred_skin_device", return_value=torch.device("cuda")):
        with mock.patch.object(skin_mod, "_skin_frames_kimodo_native", side_effect=fake_skin):
            with mock.patch.object(torch.cuda, "empty_cache"):
                skin_mod._skin_kimodo_native_with_fallback(rot, pos, skeleton)

    assert calls == [None, 32]


def test_gpu_oom_halves_chunk_before_cpu(skeleton, patch_chunk_size):
    patch_chunk_size(32)
    rot, pos = _rot_pos(100)
    calls: list[tuple[str, int | None]] = []

    def fake_skin(rot_np, pos_np, skel, device, chunk_frames):
        calls.append((device.type, chunk_frames))
        if device.type == "cuda":
            raise torch.cuda.OutOfMemoryError("simulated")
        T = rot_np.shape[0]
        return np.zeros((T, 10, 3), dtype=np.float32), np.zeros((4, 3), dtype=np.int32)

    with mock.patch.object(skin_mod, "_preferred_skin_device", return_value=torch.device("cuda")):
        with mock.patch.object(skin_mod, "_skin_frames_kimodo_native", side_effect=fake_skin):
            with mock.patch.object(torch.cuda, "empty_cache"):
                skin_mod._skin_kimodo_native_with_fallback(rot, pos, skeleton)

    cuda_chunks = [c for dev, c in calls if dev == "cuda"]
    assert 32 in cuda_chunks
    assert 16 in cuda_chunks
    assert 8 in cuda_chunks
    assert ("cpu", 32) in calls


def test_chunk_concat_shape(skeleton):
    rot, pos = _rot_pos(100)
    V = 12

    with mock.patch.object(skin_mod, "_get_kimodo_smplx_skin") as get_skin:
        skin_inst = mock.MagicMock()

        def skin_side_effect(rot_t, pos_t, rot_is_global=False):
            t = rot_t.shape[0]
            return torch.ones(t, V, 3)

        skin_inst.skin.side_effect = skin_side_effect
        skin_inst.faces = torch.zeros(4, 3, dtype=torch.long)
        get_skin.return_value = skin_inst

        verts, faces = skin_mod._skin_frames_kimodo_native(
            rot, pos, skeleton, torch.device("cpu"), chunk_frames=32
        )

    assert verts.shape == (100, V, 3)
    assert faces.shape == (4, 3)
    assert skin_inst.skin.call_count == 4


def test_skeleton_view_preserves_original_device():
    skeleton = _mock_skeleton(device_type="cuda")
    original_device = skeleton.neutral_joints.device

    view = skin_mod._skeleton_view_for_device(skeleton, torch.device("cpu"))
    assert skeleton.neutral_joints.device == original_device
    skeleton.neutral_joints.to.assert_called_once()
    assert view is not skeleton
    assert isinstance(view, skin_mod._SkeletonDeviceView)


def test_skin_device_env_cpu(skeleton, patch_chunk_size, monkeypatch):
    patch_chunk_size(32)
    monkeypatch.setenv(skin_mod._SKIN_DEVICE_ENV, "cpu")
    rot, pos = _rot_pos(100)
    calls: list[str] = []

    def fake_skin(rot_np, pos_np, skel, device, chunk_frames):
        calls.append(device.type)
        T = rot_np.shape[0]
        return np.zeros((T, 10, 3), dtype=np.float32), np.zeros((4, 3), dtype=np.int32)

    with mock.patch.object(skin_mod, "_skin_frames_kimodo_native", side_effect=fake_skin):
        skin_mod._skin_kimodo_native_with_fallback(rot, pos, skeleton)

    assert calls == ["cpu"]
    assert "cuda" not in calls
