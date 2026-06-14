"""
SMPL-X skinning for KiMoD motions.

The kimodo SMPL-X checkpoint (``Kimodo-SMPLX-RP-v1``) produces SMPL-X motion. To show a
real white human mesh in the viewer we skin per-frame vertices once, at generation time
(the worker is already warm), and stream them to the client.

This module is import-guarded: ``torch`` / ``smplx`` and the SMPL-X body-model asset are
only required when skinning actually runs. ``skin_sequence`` is deliberately defensive
about the shape of the kimodo output — the exact keys are confirmed with
``serverless.py --inspect-smplx`` in the container, and an informative error (listing the
actual keys) is raised if the structure isn't recognised.

Asset staging
-------------
Place ``SMPLX_NEUTRAL.npz`` (and optionally MALE/FEMALE) under ``SMPLX_MODEL_DIR``
(default ``storage/body_models/smplx/``). Layout expected by the ``smplx`` package:

    <SMPLX_MODEL_DIR>/smplx/SMPLX_NEUTRAL.npz

so ``SMPLX_MODEL_DIR`` is the parent that *contains* the ``smplx/`` folder.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

# Repo root = two levels up from this service package.
_REPO_ROOT = Path(__file__).resolve().parents[2]

# SMPLX_MODEL_DIR is the directory that contains the ``smplx/`` model folder.
SMPLX_MODEL_DIR = Path(
    os.environ.get("SMPLX_MODEL_DIR", str(_REPO_ROOT / "storage" / "body_models"))
).resolve()

_SMPLX_CACHE: dict[str, Any] = {}

_LFS_POINTER_PREFIX = b"version https://git-lfs.github.com/spec/v1"

_GENDER_NPZ = {
    "neutral": "SMPLX_NEUTRAL.npz",
    "male": "SMPLX_MALE.npz",
    "female": "SMPLX_FEMALE.npz",
}


def _gender_npz_path(gender: str) -> Path:
    name = _GENDER_NPZ.get(gender.lower(), f"SMPLX_{gender.upper()}.npz")
    return SMPLX_MODEL_DIR / "smplx" / name


def _is_git_lfs_pointer(path: Path) -> bool:
    try:
        if not path.is_file() or path.stat().st_size > 4096:
            return False
        with path.open("rb") as f:
            return f.read(len(_LFS_POINTER_PREFIX)) == _LFS_POINTER_PREFIX
    except OSError:
        return False


def smplx_body_model_ready(gender: str = "neutral") -> bool:
    """Return True when the on-disk body-model npz exists and is not an unpulled LFS pointer."""
    path = _gender_npz_path(gender)
    return path.is_file() and not _is_git_lfs_pointer(path)


def _require_body_model_npz(gender: str) -> Path:
    model_folder = SMPLX_MODEL_DIR / "smplx"
    npz_path = _gender_npz_path(gender)
    if not model_folder.is_dir():
        raise RuntimeError(
            f"SMPL-X body model folder not found at {model_folder}. "
            f"Stage {npz_path.name} there (set SMPLX_MODEL_DIR to override the parent dir)."
        )
    if not npz_path.is_file():
        raise RuntimeError(
            f"SMPL-X body model not found at {npz_path}. "
            f"Stage {npz_path.name} under {model_folder} "
            f"(set SMPLX_MODEL_DIR to override the parent dir)."
        )
    if _is_git_lfs_pointer(npz_path):
        raise RuntimeError(
            f"SMPL-X body model at {npz_path} is a Git LFS pointer (file not pulled). "
            "Run: git lfs install && git lfs pull"
        )
    return npz_path


# SMPL-X axis-angle ``poses`` (AMASS) layout: 55 joints × 3 = 165, split as
#   root(3) body(63) jaw(3) leye(3) reye(3) lhand(45) rhand(45)
_AMASS_SPLITS = {
    "global_orient": (0, 3),
    "body_pose": (3, 66),
    "jaw_pose": (66, 69),
    "leye_pose": (69, 72),
    "reye_pose": (72, 75),
    "left_hand_pose": (75, 120),
    "right_hand_pose": (120, 165),
}


def _smplx_available() -> bool:
    try:
        import smplx  # noqa: F401
        import torch  # noqa: F401
        return True
    except Exception:
        return False


def load_smplx_model(gender: str = "neutral", batch_size: int = 1) -> Any:
    """
    Build (and cache) an ``smplx`` SMPL-X body model from ``SMPLX_MODEL_DIR``.

    ``use_pca=False`` + ``flat_hand_mean=True`` so full 45-dim hand pose vectors are
    accepted directly (AMASS / kimodo convention) and a zero hand pose = flat hands.
    """
    key = f"{gender}:{batch_size}"
    if key in _SMPLX_CACHE:
        return _SMPLX_CACHE[key]

    if not _smplx_available():
        raise RuntimeError(
            "The 'smplx' package (and torch) are required to skin the SMPL-X mesh. "
            "Install with: pip install smplx"
        )
    _require_body_model_npz(gender)

    import smplx

    model = smplx.create(
        model_path=str(SMPLX_MODEL_DIR),
        model_type="smplx",
        gender=gender,
        use_pca=False,
        flat_hand_mean=True,
        batch_size=batch_size,
    )
    _SMPLX_CACHE[key] = model
    return model


def _get(output: dict, *names: str):
    for n in names:
        if n in output and output[n] is not None:
            return output[n]
    return None


def skin_sequence(
    output: dict,
    *,
    gender: str = "neutral",
    center_xz: tuple[float, float] | None = None,
) -> tuple[Any, Any]:
    """
    Skin a kimodo SMPL-X output dict into per-frame vertices + a static face array.

    Returns ``(vertices, faces)`` where ``vertices`` is float32 ``[T, V, 3]`` and
    ``faces`` is int32 ``[F, 3]``.

    Handles three forms, in priority order:
      1. The output already carries vertices (``vertices`` / ``verts`` / ``smplx_vertices``).
      2. AMASS-style axis-angle ``poses`` ``[T, 165]`` (+ ``betas`` / ``trans``).
      3. Per-joint rotation matrices (``global_rot_mats`` / ``poses_rotmat``) → ``pose2rot=False``.

    If none match, raises with the available keys so the adapter can be confirmed via
    ``--inspect-smplx``.
    """
    import numpy as np

    # ── 1. Vertices already provided ─────────────────────────────────────────
    verts = _get(output, "vertices", "verts", "smplx_vertices")
    if verts is not None:
        v = np.asarray(verts, dtype=np.float32)
        if v.ndim == 4:  # [B, T, V, 3] → first sample
            v = v[0]
        faces = _get(output, "faces")
        if faces is None:
            faces = load_smplx_model(gender).faces
        faces = np.asarray(faces, dtype=np.int32)
        return _finalize(v, faces, center_xz)

    import torch

    poses = _get(output, "poses", "pose", "smplx_poses")
    rotmats = _get(output, "global_rot_mats", "poses_rotmat", "rotmats")
    if poses is None and rotmats is None:
        raise RuntimeError(
            "skin_sequence: could not find vertices, AMASS 'poses', or rotation matrices "
            f"in the kimodo output. Available keys: {sorted(output.keys())}. "
            "Run `python -m services.motion_ref_gen_ai_service.serverless --inspect-smplx` "
            "to confirm the schema."
        )

    betas = _get(output, "betas")
    trans = _get(output, "trans", "transl", "root_positions")

    # ── 2. AMASS axis-angle poses [T, 165] ───────────────────────────────────
    if poses is not None:
        p = np.asarray(poses, dtype=np.float32)
        if p.ndim == 3:  # [B, T, 165] → first sample
            p = p[0]
        T = p.shape[0]
        if p.shape[1] < 165:
            raise RuntimeError(
                f"skin_sequence: AMASS 'poses' has width {p.shape[1]}, expected ≥165 (SMPL-X)."
            )
        model = load_smplx_model(gender, batch_size=T)
        kwargs = {
            name: torch.tensor(p[:, a:b], dtype=torch.float32)
            for name, (a, b) in _AMASS_SPLITS.items()
        }
        kwargs.update(_betas_transl_kwargs(betas, trans, T, torch))
        with torch.no_grad():
            out = model(return_verts=True, **kwargs)
        v = out.vertices.detach().cpu().numpy().astype(np.float32)
        return _finalize(v, np.asarray(model.faces, dtype=np.int32), center_xz)

    # ── 3. Rotation matrices, pose2rot=False ─────────────────────────────────
    r = np.asarray(rotmats, dtype=np.float32)
    if r.ndim == 5:  # [B, T, J, 3, 3]
        r = r[0]
    T, J = r.shape[0], r.shape[1]
    model = load_smplx_model(gender, batch_size=T)
    # SMPL-X expects rot-mat groups in the same joint order as the axis-angle splits
    # (root, body×21, jaw, leye, reye, lhand×15, rhand×15). Slice by joint counts.
    joint_counts = [1, 21, 1, 1, 1, 15, 15]
    names = list(_AMASS_SPLITS.keys())
    if J < sum(joint_counts):
        raise RuntimeError(
            f"skin_sequence: rotation matrices have {J} joints, expected ≥{sum(joint_counts)} (SMPL-X)."
        )
    kwargs = {}
    idx = 0
    for name, cnt in zip(names, joint_counts):
        kwargs[name] = torch.tensor(r[:, idx:idx + cnt], dtype=torch.float32)
        idx += cnt
    kwargs.update(_betas_transl_kwargs(betas, trans, T, torch))
    with torch.no_grad():
        out = model(return_verts=True, pose2rot=False, **kwargs)
    v = out.vertices.detach().cpu().numpy().astype(np.float32)
    return _finalize(v, np.asarray(model.faces, dtype=np.int32), center_xz)


def _betas_transl_kwargs(betas, trans, T: int, torch) -> dict:
    import numpy as np
    kwargs: dict[str, Any] = {}
    if betas is not None:
        b = np.asarray(betas, dtype=np.float32)
        if b.ndim == 1:
            b = np.broadcast_to(b, (T, b.shape[0]))
        elif b.ndim == 3:
            b = b[0]
        kwargs["betas"] = torch.tensor(np.ascontiguousarray(b), dtype=torch.float32)
    if trans is not None:
        t = np.asarray(trans, dtype=np.float32)
        if t.ndim == 3:
            t = t[0]
        kwargs["transl"] = torch.tensor(np.ascontiguousarray(t), dtype=torch.float32)
    return kwargs


def _finalize(vertices, faces, center_xz: tuple[float, float] | None):
    """Apply the same root-XZ centering used for the joints stream, return float32."""
    import numpy as np
    v = np.asarray(vertices, dtype=np.float32)
    if center_xz is not None:
        v = v.copy()
        v[:, :, 0] -= float(center_xz[0])
        v[:, :, 2] -= float(center_xz[1])
    return v, np.asarray(faces, dtype=np.int32)
