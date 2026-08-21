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

import logging
import os
import shutil
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

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


_KIMODO_SMPLX_SKIN_CACHE: dict[str, Any] = {}

_DEFAULT_SKIN_CHUNK_FRAMES = 32
_SKIN_CHUNK_FRAMES_ENV = "MOTION_REF_SKIN_CHUNK_FRAMES"
_SKIN_DEVICE_ENV = "MOTION_REF_SKIN_DEVICE"
_MIN_SKIN_CHUNK_FRAMES = 8


def _skin_chunk_frames() -> int:
    raw = os.environ.get(_SKIN_CHUNK_FRAMES_ENV, "").strip()
    if raw:
        try:
            value = int(raw)
            if value > 0:
                return max(value, _MIN_SKIN_CHUNK_FRAMES)
        except ValueError:
            pass
    return _DEFAULT_SKIN_CHUNK_FRAMES


def _preferred_skin_device(skeleton: Any):
    import torch

    override = os.environ.get(_SKIN_DEVICE_ENV, "auto").strip().lower()
    if override == "cpu":
        return torch.device("cpu")
    if override == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError(f"{_SKIN_DEVICE_ENV}=cuda but CUDA is not available")
        return torch.device("cuda")
    return skeleton.neutral_joints.device


class _SkeletonDeviceView:
    """Skeleton buffers on a specific device for SMPLXSkin without mutating the model."""

    def __init__(self, skeleton: Any, device) -> None:
        self.folder = skeleton.folder
        self.bone_order_names = skeleton.bone_order_names
        self.bone_index = skeleton.bone_index
        self.root_idx = skeleton.root_idx
        self.neutral_joints = skeleton.neutral_joints.to(device=device)
        self.joint_parents = skeleton.joint_parents.to(device=device)
        self._skeleton = skeleton

    def global_rots_to_local_rots(self, global_joint_rots):
        return self._skeleton.global_rots_to_local_rots(global_joint_rots.to(self.neutral_joints.device))


def _skeleton_view_for_device(skeleton: Any, device) -> Any:
    if skeleton.neutral_joints.device == device:
        return skeleton
    return _SkeletonDeviceView(skeleton, device)


def _get_kimodo_smplx_skin(skeleton: Any, device) -> Any:
    ensure_kimodo_smplx_npz(skeleton)
    SMPLXSkin = _load_kimodo_smplx_skin_class()
    cache_key = f"{Path(skeleton.folder).resolve()}:{device.type}"
    skin = _KIMODO_SMPLX_SKIN_CACHE.get(cache_key)
    if skin is None:
        skin = SMPLXSkin(_skeleton_view_for_device(skeleton, device))
        _KIMODO_SMPLX_SKIN_CACHE[cache_key] = skin
    return skin


def _skin_frames_kimodo_native(
    rot_np: Any,
    pos_np: Any,
    skeleton: Any,
    device,
    chunk_frames: int | None,
) -> tuple[Any, Any]:
    """Skin rotation/position arrays via KiMoD SMPLXSkin, optionally in frame chunks."""
    import numpy as np
    import torch

    skin = _get_kimodo_smplx_skin(skeleton, device)
    T = int(rot_np.shape[0])
    if chunk_frames is None or T <= chunk_frames:
        rot_t = torch.tensor(rot_np, dtype=torch.float32, device=device)
        pos_t = torch.tensor(pos_np, dtype=torch.float32, device=device)
        with torch.no_grad():
            verts = skin.skin(rot_t, pos_t, rot_is_global=True)
        v = verts.detach().cpu().numpy().astype(np.float32)
    else:
        chunks: list[np.ndarray] = []
        for start in range(0, T, chunk_frames):
            end = min(start + chunk_frames, T)
            rot_t = torch.tensor(rot_np[start:end], dtype=torch.float32, device=device)
            pos_t = torch.tensor(pos_np[start:end], dtype=torch.float32, device=device)
            with torch.no_grad():
                chunk_verts = skin.skin(rot_t, pos_t, rot_is_global=True)
            chunks.append(chunk_verts.detach().cpu().numpy().astype(np.float32))
            if device.type == "cuda":
                torch.cuda.empty_cache()
        v = np.concatenate(chunks, axis=0)

    faces = skin.faces.detach().cpu().numpy().astype(np.int32)
    return v, faces


def _skin_chunked_with_halving(
    rot_np: Any,
    pos_np: Any,
    skeleton: Any,
    device,
    chunk_frames: int,
) -> tuple[Any, Any]:
    """Try chunked skinning on device, halving chunk size on CUDA OOM."""
    import torch

    chunk = max(chunk_frames, _MIN_SKIN_CHUNK_FRAMES)
    while chunk >= _MIN_SKIN_CHUNK_FRAMES:
        try:
            logger.info(
                "SMPL-X skinning: chunked %s (chunk=%d, T=%d)",
                device.type,
                chunk,
                rot_np.shape[0],
            )
            return _skin_frames_kimodo_native(
                rot_np, pos_np, skeleton, device, chunk_frames=chunk
            )
        except torch.cuda.OutOfMemoryError:
            if device.type != "cuda":
                raise
            torch.cuda.empty_cache()
            if chunk <= _MIN_SKIN_CHUNK_FRAMES:
                break
            chunk //= 2
            logger.info(
                "SMPL-X skinning: GPU OOM — halving chunk to %d",
                chunk,
            )
    raise torch.cuda.OutOfMemoryError("chunked CUDA skinning exhausted all chunk sizes")


def _skin_kimodo_native_with_fallback(
    rot_np: Any,
    pos_np: Any,
    skeleton: Any,
) -> tuple[Any, Any]:
    """Skin with proactive GPU chunking and CPU fallback when VRAM is tight."""
    import torch

    chunk = _skin_chunk_frames()
    device = _preferred_skin_device(skeleton)
    T = int(rot_np.shape[0])

    if device.type == "cuda" and T > chunk:
        logger.info(
            "SMPL-X skinning: proactive chunked CUDA (T=%d > chunk=%d)",
            T,
            chunk,
        )
        try:
            return _skin_chunked_with_halving(rot_np, pos_np, skeleton, device, chunk)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            logger.info("SMPL-X skinning: chunked CUDA failed — retrying chunked CPU")
            return _skin_frames_kimodo_native(
                rot_np, pos_np, skeleton, torch.device("cpu"), chunk_frames=chunk
            )

    if device.type == "cuda":
        try:
            logger.info("SMPL-X skinning: full-batch CUDA (T=%d)", T)
            return _skin_frames_kimodo_native(
                rot_np, pos_np, skeleton, device, chunk_frames=None
            )
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            logger.info("SMPL-X skinning: full-batch GPU OOM — retrying chunked CUDA")
            try:
                return _skin_chunked_with_halving(rot_np, pos_np, skeleton, device, chunk)
            except torch.cuda.OutOfMemoryError:
                torch.cuda.empty_cache()
                logger.info("SMPL-X skinning: chunked CUDA failed — retrying chunked CPU")
                return _skin_frames_kimodo_native(
                    rot_np, pos_np, skeleton, torch.device("cpu"), chunk_frames=chunk
                )

    logger.info("SMPL-X skinning: chunked CPU (T=%d, chunk=%d)", T, chunk)
    return _skin_frames_kimodo_native(
        rot_np, pos_np, skeleton, torch.device("cpu"), chunk_frames=chunk
    )


def _kimodo_smplx_npz_path() -> Path:
    try:
        from kimodo.assets import skeleton_asset_path

        return skeleton_asset_path("smplx22", "SMPLX_NEUTRAL.npz")
    except Exception:
        return _REPO_ROOT / "kimodo" / "kimodo" / "assets" / "skeletons" / "smplx22" / "SMPLX_NEUTRAL.npz"


def _npz_is_valid(path: Path) -> bool:
    return path.is_file() and not _is_git_lfs_pointer(path)


def kimodo_smplx_asset_ready() -> bool:
    """True when SMPLX_NEUTRAL.npz exists at KiMoD smplx22/ or legacy storage/body_models/smplx/."""
    return _npz_is_valid(_kimodo_smplx_npz_path()) or _npz_is_valid(_gender_npz_path("neutral"))


def smplx_body_model_ready(gender: str = "neutral") -> bool:
    """Return True when a skinnable SMPL-X body-model npz is available (KiMoD or legacy path)."""
    if kimodo_smplx_asset_ready():
        return True
    path = _gender_npz_path(gender)
    return _npz_is_valid(path)


def ensure_kimodo_smplx_npz(skeleton: Any) -> Path:
    """
    Ensure ``SMPLX_NEUTRAL.npz`` is present under ``skeleton.folder`` for KiMoD's SMPLXSkin.

    If only the legacy ``storage/body_models/smplx/`` copy exists, link/copy it into the
    KiMoD skeleton assets folder (one-time). Windows often lacks symlink privilege, so
    we fall back to hardlink then a real file copy.
    """
    skel_dir = Path(skeleton.folder)
    target = skel_dir / "SMPLX_NEUTRAL.npz"
    if _npz_is_valid(target):
        return target

    legacy = _gender_npz_path("neutral")
    if _npz_is_valid(legacy):
        return _place_npz_at(target, legacy)

    kimodo_default = _kimodo_smplx_npz_path()
    if _npz_is_valid(kimodo_default) and kimodo_default.resolve() != target.resolve():
        return _place_npz_at(target, kimodo_default)

    raise RuntimeError(
        f"SMPL-X body model not found for KiMoD skinning. Place SMPLX_NEUTRAL.npz at "
        f"{kimodo_default} or {legacy}."
    )


def _place_npz_at(target: Path, source: Path) -> Path:
    """Make ``target`` resolve to ``source`` via symlink, hardlink, or copy."""
    source = source.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink() or target.exists():
        if _npz_is_valid(target) and target.resolve() == source:
            return target
        target.unlink()

    try:
        target.symlink_to(source)
        return target
    except OSError as exc:
        logger.info(
            "SMPL-X symlink failed (%s); trying hardlink/copy into %s",
            exc,
            target,
        )

    try:
        os.link(source, target)
        return target
    except OSError:
        pass

    shutil.copy2(source, target)
    if not _npz_is_valid(target):
        raise RuntimeError(f"Failed to stage SMPL-X body model at {target} from {source}")
    return target


def bones_from_skeleton(skeleton: Any) -> list[list[int]]:
    """Return ``[[child_idx, parent_idx], ...]`` bone pairs for browser skeleton preview."""
    bones: list[list[int]] = []
    for child_name, parent_name in skeleton.bone_order_names_with_parents:
        if parent_name is None:
            continue
        bones.append([
            int(skeleton.bone_index[child_name]),
            int(skeleton.bone_index[parent_name]),
        ])
    return bones


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


def _load_kimodo_smplx_skin_class():
    """
    Load KiMoD ``SMPLXSkin`` without importing ``kimodo.viz`` package init (which pulls viser).
    """
    import importlib.util

    path = _REPO_ROOT / "kimodo" / "kimodo" / "viz" / "smplx_skin.py"
    if not path.is_file():
        raise RuntimeError(f"KiMoD SMPLXSkin module not found at {path}")
    spec = importlib.util.spec_from_file_location("_kimodo_smplx_skin_headless", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load KiMoD SMPLXSkin from {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.SMPLXSkin


def skin_sequence_kimodo_native(
    output: dict,
    skeleton: Any,
    *,
    center_xz: tuple[float, float] | None = None,
) -> tuple[Any, Any]:
    """
    Skin kimodo-smplx-rp output (22 joints) via KiMoD's built-in ``SMPLXSkin``.
    """
    import numpy as np
    from kimodo.skeleton import SMPLXSkeleton22

    if not isinstance(skeleton, SMPLXSkeleton22):
        raise RuntimeError(
            f"skin_sequence_kimodo_native requires SMPLXSkeleton22, got {type(skeleton).__name__}"
        )

    rotmats = _get(output, "global_rot_mats", "poses_rotmat", "rotmats")
    posed = _get(output, "posed_joints", "joints")
    if rotmats is None or posed is None:
        raise RuntimeError(
            "skin_sequence_kimodo_native: output must include global_rot_mats and posed_joints."
        )

    r = np.asarray(rotmats, dtype=np.float32)
    p = np.asarray(posed, dtype=np.float32)
    if r.ndim == 5:
        r = r[0]
    if p.ndim == 4:
        p = p[0]
    if r.shape[1] != 22 or p.shape[1] != 22:
        raise RuntimeError(
            f"skin_sequence_kimodo_native: expected 22 joints, got rot={r.shape[1]} pos={p.shape[1]}"
        )

    v, faces = _skin_kimodo_native_with_fallback(r, p, skeleton)
    return _finalize(v, faces, center_xz)


def skin_sequence(
    output: dict,
    *,
    gender: str = "neutral",
    center_xz: tuple[float, float] | None = None,
    skeleton: Any | None = None,
) -> tuple[Any, Any]:
    """
    Skin a kimodo SMPL-X output dict into per-frame vertices + a static face array.

    Returns ``(vertices, faces)`` where ``vertices`` is float32 ``[T, V, 3]`` and
    ``faces`` is int32 ``[F, 3]``.

    Handles four forms, in priority order:
      1. The output already carries vertices (``vertices`` / ``verts`` / ``smplx_vertices``).
      2. KiMoD native ``SMPLXSkin`` when ``skeleton`` is SMPLXSkeleton22 with 22-joint rotmats.
      3. AMASS-style axis-angle ``poses`` ``[T, 165]`` (+ ``betas`` / ``trans``).
      4. Per-joint rotation matrices (≥55 joints) → ``pose2rot=False`` via the smplx package.

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

    # ── 2. KiMoD native SMPLXSkin (22-joint kimodo-smplx-rp) ─────────────────
    if skeleton is not None and rotmats is not None:
        r = np.asarray(rotmats, dtype=np.float32)
        if r.ndim == 5:
            r = r[0]
        if r.shape[1] == 22:
            return skin_sequence_kimodo_native(output, skeleton, center_xz=center_xz)

    if poses is None and rotmats is None:
        raise RuntimeError(
            "skin_sequence: could not find vertices, AMASS 'poses', or rotation matrices "
            f"in the kimodo output. Available keys: {sorted(output.keys())}. "
            "Run `python -m services.motion_ref_gen_ai_service.serverless --inspect-smplx` "
            "to confirm the schema."
        )

    betas = _get(output, "betas")
    trans = _get(output, "trans", "transl", "root_positions")

    # ── 3. AMASS axis-angle poses [T, 165] ───────────────────────────────────
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

    # ── 4. Rotation matrices, pose2rot=False (full SMPL-X, ≥55 joints) ───────
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
