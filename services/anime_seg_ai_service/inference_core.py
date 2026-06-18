"""Inference wrapper around vendored SkyTNT/anime-segmentation."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

_SERVICE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SERVICE_DIR.parents[1]
_VENDOR_DIR = _SERVICE_DIR / "vendor" / "anime_segmentation"
_DEFAULT_CKPT = _REPO_ROOT / "models" / "anime_seg" / "isnetis.ckpt"

_MODEL_CACHE: dict[str, Any] = {}


def default_ckpt_path() -> Path:
    return _DEFAULT_CKPT


def _vendor_on_path() -> None:
    p = str(_VENDOR_DIR)
    if p not in sys.path:
        sys.path.insert(0, p)


def _resolve_device(device: str | None = None) -> str:
    import torch

    if device and device != "auto":
        return device
    return "cuda:0" if torch.cuda.is_available() else "cpu"


def _load_model(
    *,
    net: str = "isnet_is",
    ckpt_path: str | Path | None = None,
    img_size: int = 1024,
    device: str | None = None,
) -> Any:
    import torch

    _vendor_on_path()
    from train import AnimeSegmentation  # type: ignore[import-not-found]

    dev = _resolve_device(device)
    ckpt = Path(ckpt_path) if ckpt_path else _DEFAULT_CKPT
    if not ckpt.is_file():
        raise FileNotFoundError(
            f"Anime segmentation checkpoint not found: {ckpt}. "
            "Run: python utils/download_models.py --anime-seg"
        )
    key = f"{net}:{ckpt.resolve()}:{img_size}:{dev}"
    if key in _MODEL_CACHE:
        return _MODEL_CACHE[key]

    model = AnimeSegmentation.try_load(
        net, str(ckpt), map_location=dev, img_size=img_size
    )
    model.eval()
    model.to(dev)
    model.device = dev  # type: ignore[attr-defined]
    _MODEL_CACHE[key] = model
    return model


def _get_soft_mask(
    model: Any,
    rgb: Any,
    *,
    img_size: int,
    use_amp: bool = True,
) -> Any:
    """Return H×W float mask in [0, 1]."""
    import numpy as np

    _vendor_on_path()
    from inference import get_mask  # type: ignore[import-not-found]

    return get_mask(model, rgb, use_amp=use_amp, s=img_size)


def _postprocess_mask(
    mask: Any,
    *,
    threshold: float = 0.5,
    grow_px: int = 0,
    blur_px: int = 0,
) -> Any:
    import numpy as np
    from PIL import Image, ImageFilter

    m = np.asarray(mask, dtype=np.float32)
    if m.ndim == 3:
        m = m[..., 0]
    thr = float(threshold)
    m = (m >= thr).astype(np.uint8) * 255
    if grow_px <= 0 and blur_px <= 0:
        return m
    im = Image.fromarray(m, mode="L")
    if grow_px > 0:
        size = grow_px * 2 + 1
        im = im.filter(ImageFilter.MaxFilter(size=size))
    if blur_px > 0:
        im = im.filter(ImageFilter.GaussianBlur(radius=max(1, blur_px)))
    return np.asarray(im, dtype=np.uint8)


def segment_image_to_rgba(
    image_path: str | Path,
    output_path: str | Path,
    *,
    net: str = "isnet_is",
    ckpt_path: str | Path | None = None,
    img_size: int = 1024,
    mask_threshold: float = 0.5,
    mask_grow_px: int = 0,
    mask_blur_px: int = 0,
    fp32: bool = False,
    device: str | None = None,
) -> str:
    """Segment an RGB image and write RGBA PNG with transparent background."""
    import cv2
    import numpy as np

    src = Path(image_path)
    if not src.is_file():
        raise FileNotFoundError(f"Input image not found: {src}")

    model = _load_model(
        net=net, ckpt_path=ckpt_path, img_size=img_size, device=device
    )
    bgr = cv2.imread(str(src), cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError(f"Could not read image: {src}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)

    soft = _get_soft_mask(model, rgb, img_size=img_size, use_amp=not fp32)
    alpha = _postprocess_mask(
        soft,
        threshold=mask_threshold,
        grow_px=mask_grow_px,
        blur_px=mask_blur_px,
    )
    if alpha.shape[:2] != rgb.shape[:2]:
        alpha = cv2.resize(alpha, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_LINEAR)

    rgba = np.dstack([rgb, alpha]).astype(np.uint8)
    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
    return str(out.resolve())


def options_from_dict(raw: dict[str, Any] | None) -> dict[str, Any]:
    opts = dict(raw or {})
    return {
        "net": str(opts.get("net") or "isnet_is"),
        "img_size": int(opts.get("img_size") or opts.get("imgSize") or 1024),
        "mask_threshold": float(
            opts.get("mask_threshold") if opts.get("mask_threshold") is not None else opts.get("maskThreshold", 0.5)
        ),
        "mask_grow_px": int(
            opts.get("mask_grow_px") if opts.get("mask_grow_px") is not None else opts.get("maskGrowPx") or 0
        ),
        "mask_blur_px": int(
            opts.get("mask_blur_px") if opts.get("mask_blur_px") is not None else opts.get("maskBlurPx") or 0
        ),
        "fp32": bool(opts.get("fp32")),
        "ckpt_path": opts.get("ckpt_path") or opts.get("ckptPath"),
    }
