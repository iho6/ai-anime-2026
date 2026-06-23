"""Integration tests for KiMoD multi-prompt generation wiring.

These tests mock the KiMoD model and skinning so they run without a GPU or the
``kimodo`` package installed. They verify that ``generate_motion`` invokes the model
with the official sequential multi-prompt arguments and that the starting-pose
constraint is built against the model's own skeleton (with SOMA slicing).
"""

from __future__ import annotations

import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import numpy as np
import pytest

from services.motion_ref_gen_ai_service import serverless


class _FakeModel:
    """Records the kwargs it is called with and returns a dummy motion."""

    fps = 30

    def __init__(self, nbjoints: int = 22) -> None:
        self.skeleton = SimpleNamespace(nbjoints=nbjoints)
        self.calls: list[dict] = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        nf = kwargs["num_frames"]
        total = sum(nf) if isinstance(nf, list) else int(nf)
        return {"posed_joints": np.zeros((total, 22, 3), dtype=np.float32)}


@pytest.fixture
def patched_generate(monkeypatch):
    """Patch model load + skinning so generate_motion runs CPU-only."""
    model = _FakeModel()
    monkeypatch.setattr(serverless, "_load_kimodo_model", lambda *_a, **_k: model)
    monkeypatch.setattr(serverless, "_write_mesh_stream", lambda *a, **k: (False, 0, 0))
    monkeypatch.setattr(
        "services.motion_ref_gen_ai_service.smplx_skinning.bones_from_skeleton",
        lambda *_a, **_k: [],
    )
    return model


def test_three_segments_use_sequential_multiprompt(patched_generate, tmp_path):
    segments = [
        {"text": "A person is jumping left and right", "duration": 1.0},
        {"text": "A person lands and lies on the ground", "duration": 1.0},
        {"text": "A person crawls forward on all fours", "duration": 1.0},
    ]

    serverless.generate_motion(
        segments,
        tmp_path,
        num_transition_frames=7,
        log_cb=None,
    )

    assert len(patched_generate.calls) == 1
    kwargs = patched_generate.calls[0]
    assert kwargs["multi_prompt"] is True
    assert kwargs["prompts"] == [s["text"] for s in segments]
    assert kwargs["num_frames"] == [30, 30, 30]
    assert kwargs["num_transition_frames"] == 7
    assert kwargs["post_processing"] is True
    assert callable(kwargs["progress_bar"])


def test_single_segment_is_not_multiprompt(patched_generate, tmp_path):
    serverless.generate_motion(
        [{"text": "A person walks forward", "duration": 2.0}],
        tmp_path,
        log_cb=None,
    )

    kwargs = patched_generate.calls[0]
    assert kwargs["multi_prompt"] is False
    # Single prompt passes a string + int so num_samples variations still work.
    assert kwargs["prompts"] == "A person walks forward"
    assert kwargs["num_frames"] == 60
    # num_transition_frames is only meaningful for the multi-prompt path.
    assert "num_transition_frames" not in kwargs
    assert kwargs["cfg_type"] == "separated"
    assert kwargs["cfg_weight"] == [2.0, 2.0]


def test_cfg_text_weight_passed_to_model(patched_generate, tmp_path):
    serverless.generate_motion(
        [{"text": "A person waves", "duration": 1.0}],
        tmp_path,
        cfg_text_weight=3.0,
        log_cb=None,
    )

    kwargs = patched_generate.calls[0]
    assert kwargs["cfg_type"] == "separated"
    assert kwargs["cfg_weight"] == [3.0, 2.0]


def test_segment_duration_over_max_raises(patched_generate, tmp_path):
    with pytest.raises(ValueError, match="at most 10 seconds"):
        serverless.generate_motion(
            [{"text": "A person runs", "duration": 11.0}],
            tmp_path,
            log_cb=None,
        )

    assert patched_generate.calls == []


def test_default_transition_frames_from_module(patched_generate, tmp_path):
    serverless.generate_motion(
        [
            {"text": "A person walks", "duration": 1.0},
            {"text": "A person stops walking and stands still", "duration": 1.0},
        ],
        tmp_path,
        log_cb=None,
    )
    kwargs = patched_generate.calls[0]
    assert kwargs["num_transition_frames"] == serverless._DEFAULT_NUM_TRANSITION_FRAMES


# ── Starting-pose constraint skeleton handling ────────────────────────────────


@pytest.fixture
def fake_kimodo_constraint_modules(monkeypatch):
    """Inject fake ``kimodo.constraints`` / ``kimodo.skeleton`` modules."""

    class FakeFullBodyConstraintSet:
        def __init__(self, skeleton, frame_indices, positions, rotations, **kw):
            self.skeleton = skeleton
            self.frame_indices = frame_indices
            self.positions = positions
            self.rotations = rotations
            self.kwargs = kw

    class SOMASkeleton30:  # noqa: N801 - mirror upstream class name
        pass

    constraints_mod = types.ModuleType("kimodo.constraints")
    constraints_mod.FullBodyConstraintSet = FakeFullBodyConstraintSet
    skeleton_mod = types.ModuleType("kimodo.skeleton")
    skeleton_mod.SOMASkeleton30 = SOMASkeleton30
    kimodo_pkg = sys.modules.get("kimodo") or types.ModuleType("kimodo")

    monkeypatch.setitem(sys.modules, "kimodo", kimodo_pkg)
    monkeypatch.setitem(sys.modules, "kimodo.constraints", constraints_mod)
    monkeypatch.setitem(sys.modules, "kimodo.skeleton", skeleton_mod)
    return SimpleNamespace(
        FullBodyConstraintSet=FakeFullBodyConstraintSet,
        SOMASkeleton30=SOMASkeleton30,
    )


def test_starting_pose_uses_model_skeleton_matching_joints(
    fake_kimodo_constraint_modules,
):
    model = SimpleNamespace(skeleton=SimpleNamespace(nbjoints=22))
    joints = [[0.0, 0.0, 0.0] for _ in range(22)]

    constraint = serverless._build_fullbody_constraint_at_frame0(model, joints)

    assert constraint.skeleton is model.skeleton
    assert constraint.positions.shape == (1, 22, 3)
    assert constraint.rotations.shape == (1, 22, 3, 3)


def test_starting_pose_slices_soma77_to_model_skeleton(
    fake_kimodo_constraint_modules,
):
    SOMASkeleton30 = fake_kimodo_constraint_modules.SOMASkeleton30

    class ModelSkel(SOMASkeleton30):
        nbjoints = 30
        somaskel77 = object()

        def get_skel_slice(self, _src):
            return list(range(30))  # first 30 of the 77-joint pose

    model = SimpleNamespace(skeleton=ModelSkel())
    joints = [[float(i), 0.0, 0.0] for i in range(77)]

    constraint = serverless._build_fullbody_constraint_at_frame0(model, joints)

    assert constraint.positions.shape == (1, 30, 3)
    assert constraint.rotations.shape == (1, 30, 3, 3)


def test_starting_pose_rejects_joint_count_mismatch(
    fake_kimodo_constraint_modules,
):
    model = SimpleNamespace(skeleton=SimpleNamespace(nbjoints=22))
    joints = [[0.0, 0.0, 0.0] for _ in range(40)]  # neither 22 nor sliceable

    with pytest.raises(ValueError, match="expects 22"):
        serverless._build_fullbody_constraint_at_frame0(model, joints)
