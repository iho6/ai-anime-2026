"""Batch motion-ref frame captures → pose keypoint folder (V2Pose Seq)."""

from __future__ import annotations

import base64
import re
import tempfile
from pathlib import Path
from typing import Any, Callable

from services.character_storage import sanitize_for_folder, unique_suffix

_DATA_URL_RE = re.compile(r"^data:image/[^;]+;base64,", re.I)


def _decode_png_base64(raw: str) -> bytes:
    s = (raw or "").strip()
    s = _DATA_URL_RE.sub("", s)
    return base64.b64decode(s)


def _placed_figure_from_frame(fr: dict[str, Any]) -> dict[str, Any] | None:
    from services.figure_crop import MIN_SQUARE_WORKING_SIZE

    crop_box = fr.get("cropBox") if isinstance(fr.get("cropBox"), dict) else None
    image_width = fr.get("imageWidth")
    image_height = fr.get("imageHeight")
    if not isinstance(crop_box, dict) or not crop_box.get("width") or not crop_box.get("height"):
        return None
    if not image_width or not image_height:
        return None
    # cropBox from the frontend is already padded by FIGURE_CROP_PAD_FRAC (15%).
    # Do NOT call build_placed_figure_meta here — that adds another 15%, making the
    # paste position 30% larger than the actual mesh zoom square on the canvas.
    return {
        "canvas": {"width": int(image_width), "height": int(image_height)},
        "placement": {
            "x": int(crop_box["x"]),
            "y": int(crop_box["y"]),
            "width": int(crop_box["width"]),
            "height": int(crop_box["height"]),
        },
        "workingSquareSize": MIN_SQUARE_WORKING_SIZE,
    }


def create_v2pose_folder(folder_name: str, *, motion_key: str = "") -> dict[str, Any]:
    """Create an empty keypoint gallery folder for a V2Pose Seq run."""
    from services import reference_storage

    name = sanitize_for_folder(folder_name.strip()) or f"v2pose_{motion_key}"
    folder_id = reference_storage.ensure_keypoint_folder_empty(name, parent_folder_id=None)
    return {"folderId": folder_id, "folderName": name}


def process_v2pose_frame(
    folder_id: str,
    frame: dict[str, Any],
    *,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """Run SDPose on one captured frame and add the keypoint to folder_id."""
    from services import logic, reference_storage

    fid = str(folder_id).strip()
    layout = reference_storage.get_keypoints_layout()
    if not any(str(f.get("id")) == fid for f in layout.get("folders") or []):
        raise ValueError(f"Keypoint folder not found: {fid}")

    frame_idx = int(frame.get("frameIndex", 0))
    raw_b64 = frame.get("pngBase64") or frame.get("png_base64") or ""
    png_bytes = _decode_png_base64(str(raw_b64))
    if not png_bytes:
        raise ValueError(f"Empty PNG for frame {frame_idx}")

    tmp_root = Path(tempfile.gettempdir()) / f"v2pose_{unique_suffix()}"
    tmp_root.mkdir(parents=True, exist_ok=True)
    png_path = tmp_root / f"frame_{frame_idx:05d}.png"
    png_path.write_bytes(png_bytes)

    placed_figure = _placed_figure_from_frame(frame)
    entry = logic.make_reference_keypoint(
        str(png_path),
        log_cb=log_cb,
        placed_figure=placed_figure,
        image_is_zoomed_crop=True,  # png is the 1024×1024 zoom capture, not a full frame
    )
    reference_storage.assign_keypoints_to_folder(fid, [entry["id"]])
    item: dict[str, Any] = {
        "id": entry["id"],
        "frameIndex": frame_idx,
        "referenceRelPath": entry["referenceRelPath"],
        "keypointRelPath": entry["keypointRelPath"],
    }
    if isinstance(entry.get("placedFigure"), dict):
        item["placedFigure"] = entry["placedFigure"]
    return item


def create_diag_folder(folder_name: str, *, motion_key: str = "") -> dict[str, Any]:
    """Create an empty shots gallery folder for a diag run. Returns { folderId, folderName }."""
    from services import motion_shot_storage

    label = folder_name.strip() or f"diag_{motion_key}"
    folder = motion_shot_storage.create_shot_folder(label, [])
    return {"folderId": folder["id"], "folderName": label}


def save_diag_shot(
    motion_key: str,
    folder_id: str,
    frame: dict[str, Any],
) -> dict[str, Any]:
    """
    Composite one frame (zoomed square pasted at cropBox on full canvas) and save it
    to the shots gallery, then assign it to folder_id. Returns { shotId }.
    """
    import io

    from PIL import Image

    from services import motion_shot_storage
    from services.figure_crop import paste_on_black_canvas

    frame_idx = int(frame.get("frameIndex", 0))
    raw_b64 = frame.get("pngBase64") or frame.get("png_base64") or ""
    png_bytes = _decode_png_base64(str(raw_b64))
    if not png_bytes:
        raise ValueError(f"Empty PNG for frame {frame_idx}")

    crop_box = frame.get("cropBox") if isinstance(frame.get("cropBox"), dict) else None
    img_w = frame.get("imageWidth")
    img_h = frame.get("imageHeight")

    with Image.open(io.BytesIO(png_bytes)) as zoomed:
        if crop_box and img_w and img_h:
            composite = paste_on_black_canvas(zoomed, int(img_w), int(img_h), crop_box)
        else:
            composite = zoomed.convert("RGB")

    buf = io.BytesIO()
    composite.save(buf, format="PNG")
    composite_b64 = base64.b64encode(buf.getvalue()).decode()

    item = motion_shot_storage.save_shot(
        motion_key=motion_key,
        png_base64=composite_b64,
        frame_index=frame_idx,
        azimuth=float(frame.get("azimuth") or 0),
        elevation=float(frame.get("elevation") or 0),
        crop_box=crop_box,
        image_width=int(img_w) if img_w else None,
        image_height=int(img_h) if img_h else None,
    )
    motion_shot_storage.assign_shots_to_folder(folder_id, [item["id"]])
    return {"shotId": item["id"]}


def batch_v2pose_from_frames(
    motion_key: str,
    folder_name: str,
    frames: list[dict[str, Any]],
    *,
    log_cb: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """
    Run SDPose on each captured frame PNG and place keypoints in a new pose folder.
    """
    from services.motion_ref_storage import motion_ref_dir

    if not motion_ref_dir(motion_key).is_dir():
        raise FileNotFoundError(f"Motion not found: {motion_key}")
    if not frames:
        raise ValueError("No frames provided for V2Pose Seq.")

    folder = create_v2pose_folder(folder_name, motion_key=motion_key)
    folder_id = folder["folderId"]
    name = folder["folderName"]

    items: list[dict[str, Any]] = []
    sorted_frames = sorted(frames, key=lambda f: int(f.get("frameIndex", 0)))

    for i, fr in enumerate(sorted_frames):
        frame_idx = int(fr.get("frameIndex", i))
        if log_cb:
            log_cb(f"V2Pose frame {i + 1}/{len(sorted_frames)} (f{frame_idx})…")
        items.append(process_v2pose_frame(folder_id, fr, log_cb=log_cb))

    if log_cb:
        log_cb(f"V2Pose Seq complete — {len(items)} poses in folder {name!r}.")

    return {"folderId": folder_id, "folderName": name, "items": items}
