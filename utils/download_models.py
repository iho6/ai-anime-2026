#!/usr/bin/env python3
"""Download model weights for AI workflows (anime2026).

Reference: ComfyUI / Hugging Face model layouts for anime2026 services.

Usage:
    python utils/download_models.py --multi-angle [--hf-token YOUR_TOKEN]
    python utils/download_models.py --image-edit [--hf-token YOUR_TOKEN]
    python utils/download_models.py --anime-gen
    python utils/download_models.py --background-removal
    python utils/download_models.py --pose-keypoint
    python utils/download_models.py --flf-lightning [--hf-token YOUR_TOKEN]
    python utils/download_models.py --flux-fill --hf-token YOUR_TOKEN  # mask edit + outpaint
    python utils/download_models.py --qwen-t2i  # reference t2i gen (Qwen-Image 2512)
    python utils/download_models.py --sound-gen  # Stable Audio Open 1.0 (sound_gen_ai_service)
    python utils/download_models.py --music-gen  # ACE-Step 1.5 turbo (music_gen_ai_service)
    python utils/download_models.py --sam3  # SAM 3.1 multiplex (sam3_segment_ai_service)
    python utils/download_models.py --all  # all stacks (deduplicated)
    python utils/download_models.py --all --force-redownload  # re-fetch HF weights (testing)
"""

import sys
import os
import shutil
import time
import uuid
import urllib.error
import urllib.request
import ssl
from pathlib import Path

from tqdm import tqdm


class _TqdmPipeLineStdout:
    """Turn tqdm's CR-based refreshes into newline-terminated lines for piped parents."""

    def __init__(self, raw):
        self._raw = raw
        self.encoding = getattr(raw, "encoding", None)

    def write(self, s: str) -> int:
        if not s:
            return 0
        if "\r" in s:
            core = s.split("\r")[-1].rstrip()
            if core:
                self._raw.write(core + "\n")
            return len(s)
        self._raw.write(s)
        return len(s)

    def flush(self) -> None:
        self._raw.flush()


# Models required for multi-angle workflow (Qwen-Image-Edit-2511 + Multiple-Angles LoRA)
# Base stack same as qwen-multiview; plus the multi-angle LoRA from fal.
MULTI_ANGLE_MODELS = [
    {
        "name": "qwen_2.5_vl_7b_fp8_scaled.safetensors (Text Encoder)",
        "url": "https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
        "path": "comfyui/models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
    },
    {
        "name": "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors (LoRA)",
        "url": "https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning/resolve/main/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
        "path": "comfyui/models/loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
    },
    {
        "name": "qwen_image_edit_2511_bf16.safetensors (Diffusion Model)",
        "url": "https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2511_bf16.safetensors",
        "path": "comfyui/models/diffusion_models/qwen_image_edit_2511_bf16.safetensors",
    },
    {
        "name": "qwen_image_vae.safetensors (VAE)",
        "url": "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors",
        "path": "comfyui/models/vae/qwen_image_vae.safetensors",
    },
    {
        "name": "qwen-image-edit-2511-multiple-angles-lora.safetensors (Multi-Angle LoRA)",
        "url": "https://huggingface.co/fal/Qwen-Image-Edit-2511-Multiple-Angles-LoRA/resolve/main/qwen-image-edit-2511-multiple-angles-lora.safetensors",
        "path": "comfyui/models/loras/qwen-image-edit-2511-multiple-angles-lora.safetensors",
    },
]

IMAGE_EDIT_MODELS = [
    {
        "name": "qwen_2.5_vl_7b_fp8_scaled.safetensors (Text Encoder)",
        "url": "https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
        "path": "comfyui/models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
    },
    {
        "name": "Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors (LoRA)",
        "url": "https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
        "path": "comfyui/models/loras/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors",
    },
    {
        "name": "qwen_image_edit_2509_fp8_e4m3fn.safetensors (Diffusion Model)",
        "url": "https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors",
        "path": "comfyui/models/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors",
    },
    {
        "name": "qwen_image_vae.safetensors (VAE)",
        "url": "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors",
        "path": "comfyui/models/vae/qwen_image_vae.safetensors",
    },
]

# Anima preview T2I (image_anima_preview.json) — circlestone-labs/Anima
ANIME_GEN_MODELS = [
    {
        "name": "anima-preview.safetensors (Diffusion)",
        "url": "https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/diffusion_models/anima-preview.safetensors",
        "path": "comfyui/models/diffusion_models/anima-preview.safetensors",
    },
    {
        "name": "qwen_3_06b_base.safetensors (CLIP)",
        "url": "https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/text_encoders/qwen_3_06b_base.safetensors",
        "path": "comfyui/models/text_encoders/qwen_3_06b_base.safetensors",
    },
    {
        "name": "qwen_image_vae.safetensors (VAE, Anima bundle)",
        "url": "https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/vae/qwen_image_vae.safetensors",
        "path": "comfyui/models/vae/qwen_image_vae.safetensors",
    },
]

# SDPose whole-body checkpoint (utility_sdpose_ood_* workflows)
POSE_KEYPOINT_MODELS = [
    {
        "name": "sdpose_wholebody_fp16.safetensors (SDPose checkpoint)",
        "url": "https://huggingface.co/Comfy-Org/SDPose/resolve/main/checkpoints/sdpose_wholebody_fp16.safetensors",
        "path": "comfyui/models/checkpoints/sdpose_wholebody_fp16.safetensors",
    },
]

# Wan 2.2 first-last-frame (FLF) lightning API — video_wan2_2_14B_flf2v_lightning_api.json
# URLs from Comfy-Org repackaged repos (same as workflow_library/video/video_wan2_2_14B_flf2v.json).
FLF_LIGHTNING_MODELS = [
    {
        "name": "umt5_xxl_fp8_e4m3fn_scaled.safetensors (Wan CLIP / text encoder)",
        "url": "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        "path": "comfyui/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    },
    {
        "name": "wan_2.1_vae.safetensors (VAE)",
        "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors",
        "path": "comfyui/models/vae/wan_2.1_vae.safetensors",
    },
    {
        "name": "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors (UNet high noise)",
        "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
        "path": "comfyui/models/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
    },
    {
        "name": "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors (UNet low noise)",
        "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
        "path": "comfyui/models/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
    },
    {
        "name": "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors (LoRA)",
        "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
        "path": "comfyui/models/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
    },
    {
        "name": "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors (LoRA)",
        "url": "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
        "path": "comfyui/models/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
    },
]

# Flux.1 Fill dev (inpaint) — shared by mask_guided_edit_ai_service
# (flux_fill_inpaint_example) AND the location outpaint workflow
# (flux_fill_outpaint); identical weights, deduplicated by destination path.
# flux1-fill-dev.safetensors lives in a gated repo and needs an HF token.
FLUX_FILL_MODELS = [
    {
        "name": "flux1-fill-dev.safetensors (UNet, gated)",
        "url": "https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev/resolve/main/flux1-fill-dev.safetensors",
        "path": "comfyui/models/diffusion_models/flux1-fill-dev.safetensors",
    },
    {
        "name": "clip_l.safetensors (CLIP-L text encoder)",
        "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors",
        "path": "comfyui/models/text_encoders/clip_l.safetensors",
    },
    {
        "name": "t5xxl_fp16.safetensors (T5-XXL text encoder)",
        "url": "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors",
        "path": "comfyui/models/text_encoders/t5xxl_fp16.safetensors",
    },
    {
        "name": "ae.safetensors (Flux VAE)",
        "url": "https://huggingface.co/black-forest-labs/FLUX.1-schnell/resolve/main/ae.safetensors",
        "path": "comfyui/models/vae/ae.safetensors",
    },
]

# Qwen-Image 2512 T2I — t2i_ref_gen_ai_service (image_qwen_t2i_api.json).
# Reuses the SAME text encoder + VAE as the Qwen image-edit services, so only the
# base diffusion model is a new download (the shared files are deduped away).
QWEN_T2I_MODELS = [
    {
        "name": "qwen_image_2512_fp8_e4m3fn.safetensors (Diffusion Model)",
        "url": "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors",
        "path": "comfyui/models/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors",
    },
    {
        "name": "qwen_2.5_vl_7b_fp8_scaled.safetensors (Text Encoder, shared with edit services)",
        "url": "https://huggingface.co/Comfy-Org/HunyuanVideo_1.5_repackaged/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
        "path": "comfyui/models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
    },
    {
        "name": "qwen_image_vae.safetensors (VAE, shared with edit services)",
        "url": "https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/resolve/main/split_files/vae/qwen_image_vae.safetensors",
        "path": "comfyui/models/vae/qwen_image_vae.safetensors",
    },
]

# Stable Audio Open 1.0 — sound_gen_ai_service.
SOUND_GEN_MODELS = [
    {
        "name": "stable-audio-open-1.0.safetensors (Checkpoint)",
        "url": "https://huggingface.co/stabilityai/stable-audio-open-1.0/resolve/main/model.safetensors",
        "path": "comfyui/models/checkpoints/stable-audio-open-1.0.safetensors",
    },
    {
        "name": "t5-base.safetensors (Text Encoder)",
        "url": "https://huggingface.co/google-t5/t5-base/resolve/main/model.safetensors",
        "path": "comfyui/models/text_encoders/t5-base.safetensors",
    },
]

# ACE-Step 1.5 turbo — music_gen_ai_service.
MUSIC_GEN_MODELS = [
    {
        "name": "acestep_v1.5_turbo.safetensors (Diffusion Model)",
        "url": "https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/diffusion_models/acestep_v1.5_turbo.safetensors",
        "path": "comfyui/models/diffusion_models/acestep_v1.5_turbo.safetensors",
    },
    {
        "name": "qwen_0.6b_ace15.safetensors (Text Encoder)",
        "url": "https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_0.6b_ace15.safetensors",
        "path": "comfyui/models/text_encoders/qwen_0.6b_ace15.safetensors",
    },
    {
        "name": "qwen_4b_ace15.safetensors (Text Encoder LLM)",
        "url": "https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/text_encoders/qwen_4b_ace15.safetensors",
        "path": "comfyui/models/text_encoders/qwen_4b_ace15.safetensors",
    },
    {
        "name": "ace_1.5_vae.safetensors (VAE)",
        "url": "https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files/resolve/main/split_files/vae/ace_1.5_vae.safetensors",
        "path": "comfyui/models/vae/ace_1.5_vae.safetensors",
    },
]

# SAM 3.1 Multiplex — sam3_segment_ai_service (timeline segment).
SAM3_MODELS = [
    {
        "name": "sam3.1_multiplex_fp16.safetensors (SAM 3.1 checkpoint)",
        "url": "https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors",
        "path": "comfyui/models/checkpoints/sam3.1_multiplex_fp16.safetensors",
    },
]

# SkyTNT anime-segmentation — anime_seg_ai_service.
ANIME_SEG_MODELS = [
    {
        "name": "isnetis.ckpt (anime segmentation)",
        "url": "https://huggingface.co/skytnt/anime-seg/resolve/main/isnetis.ckpt",
        "path": "models/anime_seg/isnetis.ckpt",
    },
]


SERVICE_MODEL_MAP = {
    "multi_angle": MULTI_ANGLE_MODELS,
    "image_edit": IMAGE_EDIT_MODELS,
    "anime_gen": ANIME_GEN_MODELS,
    "pose_keypoint": POSE_KEYPOINT_MODELS,
    "flf_lightning": FLF_LIGHTNING_MODELS,
    "flux_fill": FLUX_FILL_MODELS,
    "qwen_t2i": QWEN_T2I_MODELS,
    "sound_gen": SOUND_GEN_MODELS,
    "music_gen": MUSIC_GEN_MODELS,
    "sam3": SAM3_MODELS,
    "anime_seg": ANIME_SEG_MODELS,
}


def _is_windows_sharing_violation(exc: BaseException) -> bool:
    if os.name != "nt":
        return False
    return isinstance(exc, OSError) and getattr(exc, "winerror", None) == 32


def _unique_part_path(destination_path: Path) -> Path:
    """Return a process-unique temporary path beside the destination file."""
    token = f"{os.getpid()}.{uuid.uuid4().hex[:12]}"
    return destination_path.with_name(f"{destination_path.name}.part.{token}")


def _safe_unlink(path: Path | None) -> None:
    if path is None:
        return
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except Exception:
        pass


def _replace_with_retry(part: Path, dest: Path) -> None:
    """Commit ``.part`` to final path; retry on transient Windows file locks (WinError 32)."""
    max_attempts = 25
    delay_s = 0.25
    for attempt in range(max_attempts):
        try:
            os.replace(part, dest)
            return
        except OSError as e:
            if not _is_windows_sharing_violation(e):
                raise
            if attempt >= max_attempts - 1:
                print(
                    "    HINT: Another program may be locking files under comfyui\\models\\ "
                    "(e.g. Windows Defender, Explorer preview, or cloud sync). "
                    "Try again or add an exclusion; re-run this script to resume."
                )
                raise
            time.sleep(delay_s)
            delay_s = min(2.0, delay_s + 0.25)


def download_file(
    url: str,
    destination: str,
    description: str = None,
    hf_token: str = None,
    skip_ssl_verify: bool = False,
    force_redownload: bool = False,
) -> bool:
    """Download a file from URL to destination with optional HF authentication."""
    destination_path = Path(destination)
    destination_path.parent.mkdir(parents=True, exist_ok=True)

    part_path: Path | None = None
    if force_redownload:
        if destination_path.exists():
            try:
                destination_path.unlink()
                print(f"  --force-redownload: removed existing {destination_path.name}")
            except OSError as e:
                print(f"  ERROR: Could not remove existing file {destination_path}: {e}")
                return False

    if destination_path.exists():
        file_size = destination_path.stat().st_size
        print(f"  OK  {description or destination_path.name} already exists ({file_size / (1024*1024):.1f} MB)")
        return True

    print(f"  Downloading {description or destination_path.name}...")
    print(f"    From: {url}")
    print(f"    To: {destination}")

    try:
        ssl_context = None
        if skip_ssl_verify:
            ssl_context = ssl.create_default_context()
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
            print("    WARN: SSL verification disabled for this download")

        req = urllib.request.Request(url)
        if hf_token and "huggingface.co" in url:
            req.add_header("Authorization", f"Bearer {hf_token}")

        part_path = _unique_part_path(destination_path)

        with urllib.request.urlopen(req, context=ssl_context) as resp:
            total = resp.headers.get("Content-Length")
            total_bytes = int(total) if total and str(total).isdigit() else None
            chunk_size = 1024 * 1024
            desc = (description or destination_path.name).strip()

            with tqdm(
                total=total_bytes,
                unit="B",
                unit_scale=True,
                unit_divisor=1024,
                desc=desc,
                dynamic_ncols=False,
                disable=False,
                mininterval=1.0,
                file=_TqdmPipeLineStdout(sys.stdout),
            ) as bar:
                with open(part_path, "wb") as f:
                    while True:
                        chunk = resp.read(chunk_size)
                        if not chunk:
                            break
                        f.write(chunk)
                        bar.update(len(chunk))
                    f.flush()
                    os.fsync(f.fileno())

        part_size = part_path.stat().st_size if part_path.exists() else 0
        if part_size <= 0:
            print("  ERROR: Download failed - empty file")
            _safe_unlink(part_path)
            return False

        _replace_with_retry(part_path, destination_path)
        part_path = None
        file_size = destination_path.stat().st_size
        print(f"  OK  Successfully downloaded ({file_size / (1024*1024):.1f} MB)")
        return True

    except urllib.error.HTTPError as e:
        _safe_unlink(part_path)
        if e.code in (401, 403):
            print(f"  ERROR: Authorization failed: {e}")
            print("    Get your token from: https://huggingface.co/settings/tokens")
            print("    Then run: python utils/download_models.py --<flag> --hf-token YOUR_TOKEN")
        else:
            print(f"  ERROR: Download failed: {e}")
        return False
    except Exception as e:
        print(f"  ERROR: Download failed: {e}")
        _safe_unlink(part_path)
        return False


def download_model_group(
    title: str,
    models: list[dict],
    hf_token: str | None = None,
    *,
    force_redownload: bool = False,
) -> bool:
    """Download all models in a group."""
    print("=" * 60)
    print(title)
    print("=" * 60)
    Path("comfyui/models/configs").mkdir(parents=True, exist_ok=True)
    print("[OK] Created/verified comfyui/models/configs directory")

    success = 0
    for model in models:
        if download_file(
            model["url"],
            model["path"],
            model["name"],
            hf_token,
            force_redownload=force_redownload,
        ):
            success += 1

    print("\n" + "=" * 60)
    print(f"Download complete: {success}/{len(models)} models")
    print("=" * 60)
    return success == len(models)


def _dedupe_models(models: list[dict]) -> list[dict]:
    """Deduplicate models by destination path (first definition wins)."""
    deduped: list[dict] = []
    seen_paths: set[str] = set()
    for model in models:
        path = str(model.get("path", "")).strip()
        if not path or path in seen_paths:
            continue
        deduped.append(model)
        seen_paths.add(path)
    return deduped


def _collect_selected_models(args) -> list[dict]:
    selected_keys: list[str] = []
    if args.all:
        selected_keys = list(SERVICE_MODEL_MAP.keys())
    else:
        if args.multi_angle:
            selected_keys.append("multi_angle")
        if args.image_edit:
            selected_keys.append("image_edit")
        if args.anime_gen:
            selected_keys.append("anime_gen")
        if args.pose_keypoint:
            selected_keys.append("pose_keypoint")
        if args.flf_lightning:
            selected_keys.append("flf_lightning")
        if args.flux_fill:
            selected_keys.append("flux_fill")
        if args.qwen_t2i:
            selected_keys.append("qwen_t2i")
        if args.sound_gen:
            selected_keys.append("sound_gen")
        if args.music_gen:
            selected_keys.append("music_gen")
        if args.sam3:
            selected_keys.append("sam3")
        if args.anime_seg:
            selected_keys.append("anime_seg")

    selected_models: list[dict] = []
    for key in selected_keys:
        selected_models.extend(SERVICE_MODEL_MAP[key])
    return _dedupe_models(selected_models)


def run_background_removal_bootstrap(
    hf_token: str | None = None,
    *,
    force_redownload: bool = False,
) -> bool:
    """
    Prefetch RMBG-2.0 into comfyui/models/RMBG/RMBG-2.0 for ComfyUI-RMBG
    (background_removal_ai_service).
    """
    print("=" * 60)
    print("Background-removal model bootstrap (briaai/RMBG-2.0)")
    print("=" * 60)
    try:
        from huggingface_hub import snapshot_download
    except ImportError as e:
        print(f"  ERROR: huggingface_hub is required: {e}")
        print("=" * 60)
        return False

    dest = Path.cwd() / "comfyui" / "models" / "RMBG" / "RMBG-2.0"
    token = (hf_token or os.environ.get("HF_TOKEN") or "").strip() or None

    if force_redownload and dest.exists():
        try:
            shutil.rmtree(dest)
            print(f"  --force-redownload: removed {dest}")
        except OSError as e:
            print(f"  ERROR: could not remove {dest}: {e}")
            print("=" * 60)
            return False

    try:
        if dest.exists() and any(dest.iterdir()):
            print(f"  OK  RMBG-2.0 already present at {dest}")
            print("=" * 60)
            return True
    except OSError:
        pass

    try:
        snapshot_download(
            repo_id="briaai/RMBG-2.0",
            local_dir=str(dest),
            token=token,
        )
        print(f"  OK  briaai/RMBG-2.0 -> {dest}")
        print("=" * 60)
        return True
    except Exception as e:
        print(f"  ERROR: RMBG-2.0 download failed: {e}")
        print(
            "  Tip: accept the model license on Hugging Face; set HF_TOKEN if gated."
        )
        print("=" * 60)
        return False


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Download model weights for ComfyUI AI service workflows.",
        epilog=(
            "Examples:\n"
            "  python utils/download_models.py --multi-angle --hf-token hf_xxx\n"
            "  python utils/download_models.py --image-edit\n"
            "  python utils/download_models.py --anime-gen\n"
            "  python utils/download_models.py --background-removal\n"
            "  python utils/download_models.py --pose-keypoint\n"
            "  python utils/download_models.py --flf-lightning\n"
            "  python utils/download_models.py --flux-fill --hf-token hf_xxx\n"
            "  python utils/download_models.py --qwen-t2i\n"
            "  python utils/download_models.py --sound-gen\n"
            "  python utils/download_models.py --music-gen\n"
            "  python utils/download_models.py --sam3\n"
            "  python utils/download_models.py --anime-seg\n"
            "  python utils/download_models.py --all"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--multi-angle",
        action="store_true",
        help="Download models for multi-angle workflow (Qwen-Image-Edit-2511 + Multiple-Angles LoRA)",
    )
    parser.add_argument(
        "--image-edit",
        action="store_true",
        help="Download models for image_edit_ai_service (Qwen-Image-Edit 2509 + Lightning LoRA)",
    )
    parser.add_argument(
        "--anime-gen",
        action="store_true",
        help="Download models for anime_img_gen_ai_service (Anima preview T2I)",
    )
    parser.add_argument(
        "--background-removal",
        action="store_true",
        help=(
            "Download RMBG-2.0 weights into comfyui/models/RMBG/RMBG-2.0 "
            "(ComfyUI-RMBG / background_removal_ai_service)"
        ),
    )
    parser.add_argument(
        "--pose-keypoint",
        action="store_true",
        help="Download SDPose checkpoint for pose_keypoint_ai_service",
    )
    parser.add_argument(
        "--flf-lightning",
        action="store_true",
        help=(
            "Download Wan 2.2 FLF lightning weights for flf2video_ai_service "
            "(video_wan2_2_14B_flf2v_lightning_api; large download, tens of GB)"
        ),
    )
    parser.add_argument(
        "--flux-fill",
        action="store_true",
        dest="flux_fill",
        help=(
            "Download Flux.1 Fill dev weights for mask_guided_edit_ai_service and the "
            "location outpaint workflow (flux1-fill-dev is gated; needs --hf-token)"
        ),
    )
    parser.add_argument(
        "--qwen-t2i",
        action="store_true",
        dest="qwen_t2i",
        help=(
            "Download Qwen-Image 2512 T2I weights for t2i_ref_gen_ai_service "
            "(image_qwen_t2i; reuses the Qwen text encoder + VAE from the edit services)"
        ),
    )
    parser.add_argument(
        "--sound-gen",
        action="store_true",
        dest="sound_gen",
        help=(
            "Download Stable Audio Open 1.0 weights for sound_gen_ai_service "
            "(timeline Audio tab)"
        ),
    )
    parser.add_argument(
        "--music-gen",
        action="store_true",
        dest="music_gen",
        help=(
            "Download ACE-Step 1.5 turbo weights for music_gen_ai_service "
            "(timeline Music tab)"
        ),
    )
    parser.add_argument(
        "--sam3",
        action="store_true",
        help=(
            "Download SAM 3.1 multiplex checkpoint for sam3_segment_ai_service "
            "(timeline Segment)"
        ),
    )
    parser.add_argument(
        "--anime-seg",
        action="store_true",
        help=(
            "Download isnetis.ckpt for anime_seg_ai_service "
            "(anime character background removal)"
        ),
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Download all service model stacks with deduplication by destination path",
    )
    parser.add_argument(
        "--force-redownload",
        action="store_true",
        help=(
            "Delete existing destination files and re-download HF weights "
            "(for timing tests or repair; also reapplies to RMBG-2.0 folder "
            "when --background-removal or --all is used)"
        ),
    )
    parser.add_argument(
        "--hf-token",
        type=str,
        help="Hugging Face API token (or set HF_TOKEN env var)",
    )
    args = parser.parse_args()

    if (
        not args.multi_angle
        and not args.image_edit
        and not args.anime_gen
        and not args.background_removal
        and not args.pose_keypoint
        and not args.flf_lightning
        and not args.flux_fill
        and not args.qwen_t2i
        and not args.sound_gen
        and not args.music_gen
        and not args.sam3
        and not args.anime_seg
        and not args.all
    ):
        parser.print_help()
        print("\nError: specify at least one model flag (or --all).")
        sys.exit(1)

    hf_token = args.hf_token or os.environ.get("HF_TOKEN")
    if not hf_token:
        print("\nWarning: No Hugging Face token provided. Some downloads may fail.")
        print("Get your token from: https://huggingface.co/settings/tokens\n")

    ok = True
    selected_models = _collect_selected_models(args)
    if selected_models:
        ok = download_model_group(
            "Service model download (deduplicated by destination path)",
            selected_models,
            hf_token,
            force_redownload=args.force_redownload,
        ) and ok
    if args.background_removal or args.all:
        ok = run_background_removal_bootstrap(
            hf_token=hf_token,
            force_redownload=args.force_redownload,
        ) and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
