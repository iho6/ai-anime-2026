"""
Figure crop / placement helpers for motion-ref keypoint and Qwen generation.

A ``placedFigure`` stores the layout contract (canvas size, pixel placement,
working square size):

- **SDPose** (``run_pose_keypoint_for_image``): 1024² square crops; skeleton pasted
  on a full-size black canvas. ``squareRefCropRelPath`` / ``squareKeypointCropRelPath``
  cache those crops.
- **Qwen primary**: full base identity image (character starting portrait) — no crop.
- **Qwen keypoint aux**: 1024² crop at ``placement`` (enlarged pose, less whitespace).
- **Qwen output**: only the model result is pasted onto a fresh white plate at
  ``placedFigure`` coordinates (never the identity input).
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from PIL import Image

FIGURE_CROP_PAD_FRAC = 0.15
MIN_CROP_SIZE = 64
MIN_SQUARE_WORKING_SIZE = 1024


def pad_clamp_bbox(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    img_w: int,
    img_h: int,
    *,
    pad_frac: float = FIGURE_CROP_PAD_FRAC,
    min_size: int = MIN_CROP_SIZE,
) -> dict[str, int]:
    """Expand an AABB by ``pad_frac``, clamp to image bounds, enforce minimum size."""
    if img_w < 1 or img_h < 1:
        raise ValueError("Image dimensions must be positive.")
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    bw = max(x2 - x1, 1.0)
    bh = max(y2 - y1, 1.0)
    pad_x = bw * pad_frac
    pad_y = bh * pad_frac
    x1 -= pad_x
    y1 -= pad_y
    x2 += pad_x
    y2 += pad_y
    ix1 = int(max(0, min(img_w - 1, round(x1))))
    iy1 = int(max(0, min(img_h - 1, round(y1))))
    ix2 = int(max(ix1 + 1, min(img_w, round(x2))))
    iy2 = int(max(iy1 + 1, min(img_h, round(y2))))
    w = ix2 - ix1
    h = iy2 - iy1
    if w < min_size:
        extra = min_size - w
        ix1 = max(0, ix1 - extra // 2)
        ix2 = min(img_w, ix1 + min_size)
        ix1 = max(0, ix2 - min_size)
        w = ix2 - ix1
    if h < min_size:
        extra = min_size - h
        iy1 = max(0, iy1 - extra // 2)
        iy2 = min(img_h, iy1 + min_size)
        iy1 = max(0, iy2 - min_size)
        h = iy2 - iy1
    return {"x": ix1, "y": iy1, "width": w, "height": h}


def pad_clamp_square_bbox(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    img_w: int,
    img_h: int,
    *,
    pad_frac: float = FIGURE_CROP_PAD_FRAC,
    min_size: int = MIN_CROP_SIZE,
) -> dict[str, int]:
    """Pad/clamp AABB, then expand to a centered square within image bounds."""
    box = pad_clamp_bbox(x1, y1, x2, y2, img_w, img_h, pad_frac=pad_frac, min_size=min_size)
    x, y, w, h = placement_box(box)
    side = max(w, h)
    cx = x + w / 2.0
    cy = y + h / 2.0
    nx1 = int(round(cx - side / 2.0))
    ny1 = int(round(cy - side / 2.0))
    nx2 = nx1 + side
    ny2 = ny1 + side
    if nx1 < 0:
        nx2 -= nx1
        nx1 = 0
    if ny1 < 0:
        ny2 -= ny1
        ny1 = 0
    if nx2 > img_w:
        shift = nx2 - img_w
        nx1 = max(0, nx1 - shift)
        nx2 = img_w
    if ny2 > img_h:
        shift = ny2 - img_h
        ny1 = max(0, ny1 - shift)
        ny2 = img_h
    side = min(nx2 - nx1, ny2 - ny1)
    if side < min_size:
        side = min(min_size, img_w, img_h)
        cx = min(max(cx, side / 2.0), img_w - side / 2.0)
        cy = min(max(cy, side / 2.0), img_h - side / 2.0)
        nx1 = int(round(cx - side / 2.0))
        ny1 = int(round(cy - side / 2.0))
        nx2 = nx1 + side
        ny2 = ny1 + side
    return {"x": nx1, "y": ny1, "width": side, "height": side}


def square_bbox_from_box(box: dict[str, int], img_w: int, img_h: int) -> dict[str, int]:
    """Convert an existing placement box to a centered square within bounds."""
    x, y, w, h = placement_box(box)
    return pad_clamp_square_bbox(float(x), float(y), float(x + w), float(y + h), img_w, img_h)


def placement_box(box: dict[str, int]) -> tuple[int, int, int, int]:
    return int(box["x"]), int(box["y"]), int(box["width"]), int(box["height"])


def centered_square_placement(img_w: int, img_h: int) -> dict[str, int]:
    """Largest axis-aligned square centered in an image (for character primary crops)."""
    if img_w < 1 or img_h < 1:
        raise ValueError("Image dimensions must be positive.")
    side = min(img_w, img_h)
    x = (img_w - side) // 2
    y = (img_h - side) // 2
    return {"x": x, "y": y, "width": side, "height": side}


def build_placed_figure_meta(
    canvas_w: int,
    canvas_h: int,
    placement: dict[str, int],
    *,
    working_square_size: int = MIN_SQUARE_WORKING_SIZE,
) -> dict[str, Any]:
    square = square_bbox_from_box(placement, canvas_w, canvas_h)
    x, y, w, h = placement_box(square)
    return {
        "canvas": {"width": int(canvas_w), "height": int(canvas_h)},
        "placement": {"x": x, "y": y, "width": w, "height": h},
        "workingSquareSize": int(working_square_size),
    }


def crop_image(
    image: Image.Image,
    box: dict[str, int],
) -> Image.Image:
    x, y, w, h = placement_box(box)
    return image.crop((x, y, x + w, y + h))


def crop_image_path(src: Path | str, box: dict[str, int], dest: Path | str) -> Path:
    dest_p = Path(dest)
    dest_p.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        crop_image(im.convert("RGB"), box).save(dest_p)
    return dest_p


def upscale_to_working_square(
    image: Image.Image,
    min_side: int = MIN_SQUARE_WORKING_SIZE,
) -> Image.Image:
    """Upscale a square image so its side is at least ``min_side`` (never downscale)."""
    rgb = image.convert("RGB")
    w, h = rgb.size
    if w != h:
        side = max(w, h)
        canvas = Image.new("RGB", (side, side), (0, 0, 0))
        ox = (side - w) // 2
        oy = (side - h) // 2
        canvas.paste(rgb, (ox, oy))
        rgb = canvas
    if rgb.width >= min_side:
        return rgb
    return rgb.resize((min_side, min_side), Image.Resampling.LANCZOS)


def extract_square_working_crop(
    image: Image.Image,
    placement: dict[str, int],
    *,
    min_side: int = MIN_SQUARE_WORKING_SIZE,
) -> Image.Image:
    """Crop square region from image and upscale to working resolution if needed."""
    cropped = crop_image(image, placement)
    return upscale_to_working_square(cropped, min_side=min_side)


def extract_square_working_crop_path(
    src: Path | str,
    placement: dict[str, int],
    dest: Path | str,
    *,
    min_side: int = MIN_SQUARE_WORKING_SIZE,
    extra_pad_frac: float = 0.0,
) -> Path:
    dest_p = Path(dest)
    dest_p.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        crop_box = placement
        if extra_pad_frac > 0:
            x, y, w, h = int(placement["x"]), int(placement["y"]), int(placement["width"]), int(placement["height"])
            crop_box = pad_clamp_square_bbox(float(x), float(y), float(x + w), float(y + h),
                                             im.width, im.height, pad_frac=extra_pad_frac)
        extract_square_working_crop(im, crop_box, min_side=min_side).save(dest_p)
    return dest_p


def paste_patch_on_canvas(
    patch: Image.Image,
    canvas_w: int,
    canvas_h: int,
    box: dict[str, int],
    *,
    background: tuple[int, int, int] = (255, 255, 255),
    feather_px: int = 0,
) -> Image.Image:
    """Paste ``patch`` (RGB or RGBA) onto a fresh canvas at ``box``."""
    x, y, w, h = placement_box(box)
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (*background, 255))
    patch_rgba = patch.convert("RGBA")
    if patch_rgba.size != (w, h):
        patch_rgba = patch_rgba.resize((w, h), Image.Resampling.LANCZOS)
    if feather_px > 0 and patch_rgba.mode == "RGBA":
        alpha = patch_rgba.split()[3]
        from PIL import ImageFilter

        alpha = alpha.filter(ImageFilter.GaussianBlur(radius=max(1, feather_px // 2)))
        patch_rgba.putalpha(alpha)
    canvas.alpha_composite(patch_rgba, dest=(x, y))
    return canvas


def paste_on_black_canvas(
    patch: Image.Image,
    canvas_w: int,
    canvas_h: int,
    box: dict[str, int],
) -> Image.Image:
    """Paste RGB patch on black (for SDPose skeleton overlays)."""
    rgb = paste_patch_on_canvas(
        patch, canvas_w, canvas_h, box, background=(0, 0, 0), feather_px=0
    )
    return rgb.convert("RGB")


def paste_on_white_canvas(
    patch: Image.Image,
    canvas_w: int,
    canvas_h: int,
    box: dict[str, int],
) -> Image.Image:
    """Paste RGB patch on white (for Qwen figure composites)."""
    rgb = paste_patch_on_canvas(
        patch, canvas_w, canvas_h, box, background=(255, 255, 255), feather_px=0
    )
    return rgb.convert("RGB")


def paste_square_working_onto_canvas(
    working_square: Image.Image,
    canvas_w: int,
    canvas_h: int,
    placement: dict[str, int],
    *,
    background: tuple[int, int, int] = (255, 255, 255),
) -> Image.Image:
    """Paste a working-resolution square patch into placement on a full-size canvas."""
    return paste_patch_on_canvas(
        working_square,
        canvas_w,
        canvas_h,
        placement,
        background=background,
        feather_px=0,
    ).convert("RGB")


def qwen_sidecar_path(plate_path: Path | str) -> Path:
    """Sibling path for native Qwen output: ``foo.png`` → ``foo_qwen.png``."""
    p = Path(plate_path)
    return p.parent / f"{p.stem}_qwen{p.suffix or '.png'}"


def composite_rgba_on_transparent_canvas(
    rgba_crop: Image.Image,
    canvas_w: int,
    canvas_h: int,
    box: dict[str, int],
) -> Image.Image:
    """Paste RGBA matte onto a full-size transparent canvas at ``box``."""
    x, y, w, h = placement_box(box)
    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    patch_rgba = rgba_crop.convert("RGBA")
    if patch_rgba.size != (w, h):
        patch_rgba = patch_rgba.resize((w, h), Image.Resampling.LANCZOS)
    # ``paste(..., mask=patch)`` multiplies the source alpha into the output
    # alpha a second time on a transparent destination. Straight-alpha
    # compositing preserves the matte (e.g. alpha 128 remains alpha 128).
    canvas.alpha_composite(patch_rgba, dest=(x, y))
    return canvas


def composite_rgba_on_white_plate(
    rgba_crop: Image.Image,
    canvas_w: int,
    canvas_h: int,
    box: dict[str, int],
) -> Image.Image:
    """Build a white-plate preview with the RGBA figure at ``box``."""
    return paste_patch_on_canvas(
        rgba_crop, canvas_w, canvas_h, box, background=(255, 255, 255), feather_px=4
    ).convert("RGB")


def composite_qwen_output_on_white_plate(
    qwen_output: Image.Image,
    placed_figure: dict[str, Any],
) -> Image.Image:
    """Paste Qwen edit output onto a fresh white canvas at ``placedFigure`` placement."""
    canvas = placed_figure["canvas"]
    placement = placed_figure["placement"]
    c_w, c_h = int(canvas["width"]), int(canvas["height"])
    return paste_on_white_canvas(qwen_output, c_w, c_h, placement)


def placed_figure_from_motion_capture_meta(
    crop_box: dict[str, Any] | None,
    image_width: int | None,
    image_height: int | None,
    *,
    already_padded: bool = False,
) -> dict[str, Any] | None:
    """Build ``placedFigure`` from motion-ref capture metadata (cropBox + canvas size).

  When ``already_padded=True`` (V2Pose zoom captures), ``cropBox`` is used as-is —
  the frontend already padded the figure bbox. When ``False``, legacy full-frame
  staging may apply ``build_placed_figure_meta`` (square expansion + pad).
    """
    if not isinstance(crop_box, dict) or not crop_box.get("width") or not crop_box.get("height"):
        return None
    if not image_width or not image_height:
        return None
    placement = {
        "x": int(crop_box["x"]),
        "y": int(crop_box["y"]),
        "width": int(crop_box["width"]),
        "height": int(crop_box["height"]),
    }
    if already_padded:
        return {
            "canvas": {"width": int(image_width), "height": int(image_height)},
            "placement": placement,
            "workingSquareSize": MIN_SQUARE_WORKING_SIZE,
        }
    return build_placed_figure_meta(int(image_width), int(image_height), placement)


def placed_figure_from_crop_meta(
    crop_box: dict[str, Any] | None,
    image_width: int | None,
    image_height: int | None,
    *,
    already_padded: bool = False,
) -> dict[str, Any] | None:
    """Build ``placedFigure`` from motion-ref capture metadata (cropBox + canvas size)."""
    return placed_figure_from_motion_capture_meta(
        crop_box,
        image_width,
        image_height,
        already_padded=already_padded,
    )


def paste_keypoint_at_placement(
    kp_path: Path | str | Image.Image,
    canvas_w: int,
    canvas_h: int,
    placement: dict[str, int],
    *,
    background: tuple[int, int, int] = (0, 0, 0),
    dest_path: Path | str | None = None,
) -> Path:
    """
    Paste an SDPose output onto a full canvas at ``placement`` with no re-crop or
    letterboxing — same contract as diag ``paste_on_black_canvas`` on zoom captures.
    The patch is only uniformly scaled to ``placement`` width×height.
    """
    if isinstance(kp_path, Image.Image):
        patch = kp_path.convert("RGB")
    else:
        src = Path(kp_path)
        if not src.is_file():
            raise FileNotFoundError(f"Keypoint image not found: {src}")
        with Image.open(src) as im:
            patch = im.convert("RGB")
    if background == (0, 0, 0):
        full = paste_on_black_canvas(patch, canvas_w, canvas_h, placement)
    else:
        full = paste_patch_on_canvas(
            patch, canvas_w, canvas_h, placement, background=background, feather_px=0
        ).convert("RGB")
    if dest_path is not None:
        out = Path(dest_path)
    else:
        from services.character_storage import unique_suffix

        out = Path(tempfile.gettempdir()) / f"kp_full_{unique_suffix()}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    full.save(out)
    return out


def prepare_sdpose_input_image(
    image: Image.Image,
    min_side: int = MIN_SQUARE_WORKING_SIZE,
) -> Image.Image:
    """Return image for SDPose input; upscale only when max side is below ``min_side``."""
    rgb = image.convert("RGB")
    w, h = rgb.size
    if max(w, h) >= min_side:
        return rgb
    scale = min_side / max(w, h)
    new_w = max(1, int(round(w * scale)))
    new_h = max(1, int(round(h * scale)))
    return rgb.resize((new_w, new_h), Image.Resampling.LANCZOS)


def paste_working_keypoint_onto_canvas(
    kp_square_path: Path | str,
    placed_figure: dict[str, Any],
    *,
    background: tuple[int, int, int] = (0, 0, 0),
    dest_path: Path | str | None = None,
) -> Path:
    """
    Upscale a SDPose square output and paste it onto a full canvas at ``placedFigure`` placement.
    """
    if not isinstance(placed_figure.get("placement"), dict) or not isinstance(
        placed_figure.get("canvas"), dict
    ):
        raise ValueError("placed_figure must include placement and canvas.")
    placement = placed_figure["placement"]
    canvas_w = int(placed_figure["canvas"]["width"])
    canvas_h = int(placed_figure["canvas"]["height"])
    min_side = int(placed_figure.get("workingSquareSize") or MIN_SQUARE_WORKING_SIZE)
    src = Path(kp_square_path)
    if not src.is_file():
        raise FileNotFoundError(f"Keypoint square not found: {src}")
    with Image.open(src) as patch:
        kp_square = upscale_to_working_square(patch, min_side=min_side)
    kp_on_bg = Image.new("RGB", (kp_square.width, kp_square.height), background)
    kp_on_bg.paste(kp_square)
    full = paste_square_working_onto_canvas(
        kp_on_bg, canvas_w, canvas_h, placement, background=background
    )
    if dest_path is not None:
        out = Path(dest_path)
    else:
        from services.character_storage import unique_suffix

        out = Path(tempfile.gettempdir()) / f"kp_full_{unique_suffix()}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    full.save(out)
    return out
