"""Shared helpers for anime2026 Comfy worker jobs: S3, downloads, Comfy API queue."""

from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import os
import os.path as osp
import re
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from functools import wraps
from pathlib import Path
from typing import Any

try:
    import boto3  # type: ignore
except ModuleNotFoundError:
    boto3 = None  # type: ignore
import requests

from services.constant import (
    AWS_REGION,
    CACHE_MAX_AGE,
    DOWNLOAD_CACHE_FILE,
    LOCAL_INPUT_DIR,
    MIME_TO_EXT,
    S3_INPUT_BUCKET,
    S3_INPUT_PREFIX,
    S3_OUTPUT_BUCKET,
    S3_OUTPUT_PREFIX,
    S3_PUBLIC_URL_BASE,
)

logger = logging.getLogger("anime2026_services")

_S3_TIMEOUT_CONFIG = (
    boto3.session.Config(connect_timeout=30, read_timeout=30) if boto3 else None
)


def _is_comfy_not_started_message(msg: str) -> bool:
    m = (msg or "").lower()
    return (
        "waiting for comfyui server to start" in m
        or "waiting for comfy ui server to start" in m
    )


def _s3_client():
    if boto3 is None:
        raise RuntimeError("boto3 is not installed; S3 operations are unavailable")
    return boto3.client(
        "s3",
        region_name=AWS_REGION,
        config=_S3_TIMEOUT_CONFIG,
    )


def gpu_preflight() -> tuple[str | None, str | None]:
    """
    Returns (error_message, ok_detail). Exactly one side is set.
    ok_detail is logged on success (e.g. device name).
    """
    try:
        import torch
    except Exception as e:
        return (f"GPU preflight failed: {type(e).__name__}: {e}", None)

    cuda_available = bool(torch.cuda.is_available())
    device_count = int(torch.cuda.device_count() or 0) if cuda_available else 0
    device_name: str | None = None
    if device_count > 0:
        try:
            device_name = str(torch.cuda.get_device_name(0))
        except Exception:
            device_name = None

    if (not cuda_available) or device_count < 1:
        reason = (
            f"GPU not available (torch.cuda.is_available={cuda_available}, "
            f"device_count={device_count})"
        )
        if device_name:
            reason += f", device_name={device_name}"
        return (reason, None)

    detail = f"device_count={device_count}, device_name={device_name}"
    return (None, detail)


def fetch_comfy_history(server_address: str, prompt_id: str) -> dict[str, Any]:
    with urllib.request.urlopen(
        f"http://{server_address}/history/{prompt_id}"
    ) as resp:
        return json.loads(resp.read().decode("utf-8"))


def summarize_comfy_history_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """
    JSON-serializable diagnostics from one Comfy /history/{prompt_id} record.

    Surfaces execution_error payloads (node, exception type/message) and a compact
    description of outputs when images are missing.
    """
    out: dict[str, Any] = {}
    status = entry.get("status") if isinstance(entry.get("status"), dict) else {}
    msgs_raw = status.get("messages")
    msgs: list[Any] = msgs_raw if isinstance(msgs_raw, list) else []

    out["status_str"] = status.get("status_str")
    out["completed"] = status.get("completed")

    message_types: list[str] = []
    execution_errors: list[dict[str, Any]] = []
    messages_tail: list[Any] = []

    for m in msgs:
        if isinstance(m, (list, tuple)) and len(m) >= 1:
            tag = str(m[0])
            message_types.append(tag)
            payload = m[1] if len(m) >= 2 else None
            if tag == "execution_error" and isinstance(payload, dict):
                err_item: dict[str, Any] = {}
                for key in (
                    "node_id",
                    "node_type",
                    "exception_type",
                    "exception_message",
                ):
                    if key in payload:
                        err_item[key] = payload.get(key)
                tb = payload.get("traceback")
                if isinstance(tb, list) and tb:
                    joined = "\n".join(str(x) for x in tb[-8:])
                    err_item["traceback_tail"] = joined[-4000:]
                elif isinstance(tb, str) and tb.strip():
                    err_item["traceback_tail"] = tb.strip()[-4000:]
                execution_errors.append(err_item)
            messages_tail.append([tag, payload])
        elif isinstance(m, str):
            message_types.append(m)
            messages_tail.append(m)
        else:
            messages_tail.append(m)

    out["message_types"] = message_types
    out["execution_errors"] = execution_errors
    if len(messages_tail) > 12:
        messages_tail = messages_tail[-12:]
    out["messages_tail"] = messages_tail

    outputs = entry.get("outputs") if isinstance(entry.get("outputs"), dict) else {}
    out["outputs_keys"] = list(outputs.keys())
    outputs_summary: dict[str, Any] = {}
    for nid, ndata in outputs.items():
        if not isinstance(ndata, dict):
            continue
        imgs = ndata.get("images")
        n_img = len(imgs) if isinstance(imgs, list) else 0
        outputs_summary[str(nid)] = {
            "keys": sorted(ndata.keys()),
            "image_count": n_img,
        }
    out["outputs_summary"] = outputs_summary
    return out


download_cache: dict[str, str] = {}
_download_locks: dict[str, threading.Lock] = {}
_download_locks_lock = threading.Lock()


def load_workflows(workflows_dir: str) -> dict:
    workflows = {}
    if not osp.isdir(workflows_dir):
        return workflows
    for file in os.listdir(workflows_dir):
        if file.endswith(".json"):
            name = osp.splitext(file)[0]
            with open(osp.join(workflows_dir, file), "r", encoding="utf-8") as f:
                workflows[name] = json.load(f)
    return workflows


def add_to_cache_file(key: str, path: str) -> None:
    try:
        os.makedirs(osp.dirname(DOWNLOAD_CACHE_FILE), exist_ok=True)
        with open(DOWNLOAD_CACHE_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps({"key": key, "value": path}, ensure_ascii=False) + "\n")
    except Exception as e:
        logger.error("Error appending to cache file: %s", e)


def load_download_cache() -> dict:
    global download_cache
    try:
        if osp.exists(DOWNLOAD_CACHE_FILE):
            with open(DOWNLOAD_CACHE_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        cache_entry = json.loads(line)
                        if (
                            isinstance(cache_entry, dict)
                            and "key" in cache_entry
                            and "value" in cache_entry
                        ):
                            download_cache[cache_entry["key"]] = cache_entry["value"]
                    except json.JSONDecodeError:
                        if ":" in line:
                            k, path = line.split(":", 1)
                            download_cache[k] = path
            logger.info("Loaded download cache with %s entries", len(download_cache))
        else:
            download_cache = {}
            logger.info("No cache file found, starting with empty cache")
    except Exception as e:
        logger.error("Error loading download cache: %s", e)
        download_cache = {}
    return download_cache


def is_uuid(string: str) -> bool:
    pattern = re.compile(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        re.IGNORECASE,
    )
    return bool(pattern.match(string))


def get_image_extension(file_path: str) -> str:
    mimetypes.init()
    mime_type, _ = mimetypes.guess_type(file_path)
    if mime_type is None:
        with open(file_path, "rb") as f:
            header = f.read(256)
            headers_to_mime = {
                b"\xFF\xD8\xFF": "image/jpeg",
                b"\x89PNG\r\n\x1A\n": "image/png",
                b"GIF87a": "image/gif",
                b"GIF89a": "image/gif",
                b"RIFF": "image/webp",
            }
            for signature, mime in headers_to_mime.items():
                if header.startswith(signature):
                    if mime == "image/webp" and not (
                        len(header) >= 12 and header[8:12] == b"WEBP"
                    ):
                        continue
                    mime_type = mime
                    break
        if mime_type is None:
            mime_type = "image/jpeg"
    extension = MIME_TO_EXT.get(mime_type)
    if extension is None and mime_type and "/" in mime_type:
        ext = mimetypes.guess_extension(mime_type)
        if ext:
            extension = ext[1:]
    return extension or "jpg"


def detect_image_content_type(image_bytes: bytes) -> str:
    if not image_bytes or len(image_bytes) < 12:
        return "image/jpeg"
    header = image_bytes[:256]
    headers_to_mime = {
        b"\xFF\xD8\xFF": "image/jpeg",
        b"\x89PNG\r\n\x1A\n": "image/png",
        b"GIF87a": "image/gif",
        b"GIF89a": "image/gif",
        b"RIFF": "image/webp",
        b"BM": "image/bmp",
    }
    for signature, mime_type in headers_to_mime.items():
        if header.startswith(signature):
            if mime_type == "image/webp":
                if len(header) >= 12 and header[8:12] == b"WEBP":
                    return mime_type
                continue
            return mime_type
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def download_from_s3(image_uuid: str) -> str:
    if image_uuid in download_cache:
        cached_path = download_cache[image_uuid]
        if osp.exists(cached_path):
            logger.info("Using cached S3 image: %s", cached_path)
            return cached_path

    with _download_locks_lock:
        if image_uuid not in _download_locks:
            _download_locks[image_uuid] = threading.Lock()
        uuid_lock = _download_locks[image_uuid]

    with uuid_lock:
        if image_uuid in download_cache:
            cached_path = download_cache[image_uuid]
            if osp.exists(cached_path):
                logger.info("Using cached S3 image (after lock): %s", cached_path)
                return cached_path

        local_path_base = f"{LOCAL_INPUT_DIR}/{image_uuid}"
        for ext in ("jpg", "jpeg", "png", "webp"):
            final_path = f"{local_path_base}.{ext}"
            if osp.exists(final_path):
                logger.info("Found existing file: %s", final_path)
                download_cache[image_uuid] = final_path
                return final_path

        object_key = f"{S3_INPUT_PREFIX.rstrip('/')}/{image_uuid}"
        temp_file = f"{local_path_base}.{uuid.uuid4().hex}.temp"
        try:
            s3_client = _s3_client()
            s3_client.download_file(S3_INPUT_BUCKET, object_key, temp_file)
            extension = get_image_extension(temp_file)
            final_path = f"{local_path_base}.{extension}"
            os.rename(temp_file, final_path)
            logger.info("Downloaded image from S3: %s", final_path)
            download_cache[image_uuid] = final_path
            add_to_cache_file(image_uuid, final_path)
            return final_path
        except Exception:
            if osp.exists(temp_file):
                try:
                    os.remove(temp_file)
                except OSError:
                    pass
            raise


def download_from_url(image_url: str) -> str:
    logger.info("Downloading image from URL: %s", image_url)
    url_hash = hashlib.md5(image_url.encode(), usedforsecurity=False).hexdigest()

    if url_hash in download_cache:
        cached_path = download_cache[url_hash]
        if osp.exists(cached_path):
            logger.info("Using cached URL image: %s", cached_path)
            return cached_path

    with _download_locks_lock:
        if url_hash not in _download_locks:
            _download_locks[url_hash] = threading.Lock()
        url_lock = _download_locks[url_hash]

    with url_lock:
        if url_hash in download_cache:
            cached_path = download_cache[url_hash]
            if osp.exists(cached_path):
                logger.info("Using cached URL image (after lock): %s", cached_path)
                return cached_path

        local_path_base = f"{LOCAL_INPUT_DIR}/{url_hash}"
        for ext in ("jpg", "jpeg", "png", "webp"):
            final_path = f"{local_path_base}.{ext}"
            if osp.exists(final_path):
                logger.info("Found existing file: %s", final_path)
                download_cache[url_hash] = final_path
                return final_path

        temp_file = f"{local_path_base}.{uuid.uuid4().hex}.temp"
        try:
            response = requests.get(image_url, stream=True, timeout=30)
            response.raise_for_status()
            with open(temp_file, "wb") as f:
                for chunk in response.iter_content(chunk_size=65536):
                    f.write(chunk)
            extension = get_image_extension(temp_file)
            final_path = f"{local_path_base}.{extension}"
            os.rename(temp_file, final_path)
            logger.info("Downloaded image from URL: %s", final_path)
            download_cache[url_hash] = final_path
            add_to_cache_file(url_hash, final_path)
            return final_path
        except Exception:
            if osp.exists(temp_file):
                try:
                    os.remove(temp_file)
                except OSError:
                    pass
            raise


_VIDEO_FILE_EXTENSIONS = ("mp4", "webm", "mov", "mkv", "avi")


def _guess_video_extension(
    file_path: str, url: str = "", content_type: str | None = None
) -> str:
    path_lower = (url or "").split("?")[0].lower()
    for ext in _VIDEO_FILE_EXTENSIONS:
        if path_lower.endswith(f".{ext}"):
            return ext
    if content_type:
        ct = content_type.split(";")[0].strip().lower()
        if ct.startswith("video/"):
            sub = ct.split("/", 1)[1]
            if sub in _VIDEO_FILE_EXTENSIONS or sub == "quicktime":
                return "mov" if sub == "quicktime" else sub
    try:
        with open(file_path, "rb") as f:
            head = f.read(12)
        if len(head) >= 8 and head[4:8] == b"ftyp":
            return "mp4"
    except OSError:
        pass
    return "mp4"


def download_video_from_url(video_url: str) -> str:
    """Download remote video to LOCAL_INPUT_DIR; returns local filesystem path."""
    logger.info("Downloading video from URL: %s", video_url)
    url_hash = hashlib.md5(video_url.encode(), usedforsecurity=False).hexdigest()
    cache_key = f"vurl:{url_hash}"

    if cache_key in download_cache:
        cached_path = download_cache[cache_key]
        if osp.exists(cached_path):
            logger.info("Using cached URL video: %s", cached_path)
            return cached_path

    with _download_locks_lock:
        if cache_key not in _download_locks:
            _download_locks[cache_key] = threading.Lock()
        url_lock = _download_locks[cache_key]

    with url_lock:
        if cache_key in download_cache:
            cached_path = download_cache[cache_key]
            if osp.exists(cached_path):
                return cached_path

        local_path_base = f"{LOCAL_INPUT_DIR}/v_{url_hash}"
        for ext in _VIDEO_FILE_EXTENSIONS:
            final_path = f"{local_path_base}.{ext}"
            if osp.exists(final_path):
                download_cache[cache_key] = final_path
                return final_path

        temp_file = f"{local_path_base}.{uuid.uuid4().hex}.temp"
        try:
            response = requests.get(video_url, stream=True, timeout=120)
            response.raise_for_status()
            ctype = response.headers.get("Content-Type")
            with open(temp_file, "wb") as f:
                for chunk in response.iter_content(chunk_size=65536):
                    f.write(chunk)
            extension = _guess_video_extension(temp_file, video_url, ctype)
            final_path = f"{local_path_base}.{extension}"
            os.rename(temp_file, final_path)
            logger.info("Downloaded video from URL: %s", final_path)
            download_cache[cache_key] = final_path
            add_to_cache_file(cache_key, final_path)
            return final_path
        except Exception:
            if osp.exists(temp_file):
                try:
                    os.remove(temp_file)
                except OSError:
                    pass
            raise


def download_video_from_s3(video_uuid: str) -> str:
    """Download S3 object keyed by UUID to a video file under LOCAL_INPUT_DIR."""
    if video_uuid in download_cache:
        cached_path = download_cache[video_uuid]
        if osp.exists(cached_path) and any(
            cached_path.lower().endswith(f".{e}") for e in _VIDEO_FILE_EXTENSIONS
        ):
            logger.info("Using cached S3 video: %s", cached_path)
            return cached_path

    with _download_locks_lock:
        if video_uuid not in _download_locks:
            _download_locks[video_uuid] = threading.Lock()
        uuid_lock = _download_locks[video_uuid]

    with uuid_lock:
        local_path_base = f"{LOCAL_INPUT_DIR}/{video_uuid}"
        for ext in _VIDEO_FILE_EXTENSIONS:
            final_path = f"{local_path_base}.{ext}"
            if osp.exists(final_path):
                download_cache[video_uuid] = final_path
                return final_path

        object_key = f"{S3_INPUT_PREFIX.rstrip('/')}/{video_uuid}"
        temp_file = f"{local_path_base}.{uuid.uuid4().hex}.temp"
        try:
            s3_client = _s3_client()
            s3_client.download_file(S3_INPUT_BUCKET, object_key, temp_file)
            extension = _guess_video_extension(temp_file, "")
            final_path = f"{local_path_base}.{extension}"
            os.rename(temp_file, final_path)
            logger.info("Downloaded video from S3: %s", final_path)
            download_cache[video_uuid] = final_path
            add_to_cache_file(video_uuid, final_path)
            return final_path
        except Exception:
            if osp.exists(temp_file):
                try:
                    os.remove(temp_file)
                except OSError:
                    pass
            raise


def download_video_input(input_ref: str) -> str:
    ref = str(input_ref or "").strip()
    if is_uuid(ref):
        return download_video_from_s3(ref)
    return download_video_from_url(ref)


def download_input(input_ref: str) -> str:
    if is_uuid(input_ref):
        return download_from_s3(input_ref)
    return download_from_url(input_ref)


def normalize_image_urls(task: dict) -> list[str]:
    """
    Resolve image inputs from a RunPod-style task dict (same rules as image_edit).

    - If ``image_urls`` is set: non-empty list of refs, or a single string (one ref).
    - Else ``image_url``: single non-empty string.
    - If both keys exist, ``image_urls`` wins.
    """
    if "image_urls" in task:
        urls = task["image_urls"]
        if isinstance(urls, str):
            return [urls]
        if not isinstance(urls, list) or not urls:
            raise ValueError("image_urls must be a non-empty list or string")
        return list(urls)
    if "image_url" in task:
        u = task["image_url"]
        if not u:
            raise ValueError("image_url must be non-empty")
        return [u]
    raise ValueError("Missing image_url or image_urls")


def _upload_to_s3_impl(
    local_path: str, object_name: str | None = None
) -> tuple[str, str, str]:
    """Returns (public_url, bucket, object_key)."""
    logger.info("Uploading image %s to s3 %s", local_path, object_name)
    content_type, _ = mimetypes.guess_type(local_path)
    is_image = content_type and content_type.startswith("image/")

    if object_name is None:
        object_name = osp.basename(local_path)
    if is_image:
        object_name = osp.splitext(object_name)[0]

    extra_args = {"CacheControl": f"max-age={CACHE_MAX_AGE}, public"}
    if content_type:
        extra_args["ContentType"] = content_type

    object_key = f"{S3_OUTPUT_PREFIX.rstrip('/')}/{object_name}"
    s3_client = _s3_client()
    s3_client.upload_file(
        local_path, S3_OUTPUT_BUCKET, object_key, ExtraArgs=extra_args
    )
    public_url = f"{S3_PUBLIC_URL_BASE.rstrip('/')}/{object_name}"
    logger.info(
        "Uploaded image %s to S3: s3://%s/%s",
        local_path,
        S3_OUTPUT_BUCKET,
        object_key,
    )
    return public_url, S3_OUTPUT_BUCKET, object_key


def upload_to_s3(local_path: str, object_name: str | None = None) -> str:
    url, _, _ = _upload_to_s3_impl(local_path, object_name)
    return url


def delete_s3_object(bucket: str, key: str) -> None:
    try:
        _s3_client().delete_object(Bucket=bucket, Key=key)
        logger.info("Deleted S3 object s3://%s/%s", bucket, key)
    except Exception as e:
        logger.warning("Failed to delete S3 object s3://%s/%s: %s", bucket, key, e)


def _looks_like_remote_image_ref(ref: str) -> bool:
    r = ref.strip()
    if r.startswith(("http://", "https://")):
        return True
    if is_uuid(r):
        return True
    return False


def upload_local_asset_to_comfy_input(
    local_path: str,
    server_address: str,
    *,
    subfolder: str = "anime2026_test_inputs",
    timeout_s: int = 120,
) -> str:
    """
    Upload a local file to ComfyUI input dir via POST /upload/image (multipart field ``image``).
    Returns a LoadImage / LoadVideo-compatible reference (subfolder/name or name).
    """
    abs_path = osp.abspath(str(local_path))
    if not osp.isfile(abs_path):
        raise FileNotFoundError(f"Local file not found: {local_path}")

    content_type, _ = mimetypes.guess_type(abs_path)
    filename = osp.basename(abs_path)
    data = {"type": "input", "overwrite": "0"}
    if subfolder:
        data["subfolder"] = subfolder

    with open(abs_path, "rb") as f:
        files = {
            "image": (
                filename,
                f,
                content_type or "application/octet-stream",
            )
        }
        resp = requests.post(
            f"http://{server_address}/upload/image",
            data=data,
            files=files,
            timeout=timeout_s,
        )
    resp.raise_for_status()
    payload = resp.json()
    name = str(payload.get("name") or "").strip()
    returned_subfolder = str(payload.get("subfolder") or "").strip()
    if not name:
        raise ValueError(f"Comfy upload returned invalid payload: {payload}")
    if returned_subfolder:
        return f"{returned_subfolder}/{name}"
    return name


def upload_local_image_to_comfy_input(
    local_path: str,
    server_address: str,
    *,
    subfolder: str = "anime2026_test_inputs",
) -> str:
    """Upload a local image to ComfyUI input dir via /upload/image."""
    return upload_local_asset_to_comfy_input(
        local_path, server_address, subfolder=subfolder, timeout_s=30
    )


def resolve_to_comfy_input_ref(
    image_ref: str,
    server_address: str,
    *,
    subfolder: str = "anime2026_inputs",
) -> str:
    """
    Convert an arbitrary image reference into a ComfyUI LoadImage-compatible input ref
    on the given Comfy server (uploaded via /upload/image when needed).
    """
    ref = str(image_ref or "").strip()
    if not ref:
        raise ValueError("image_ref is empty")

    # Already-remote refs (http(s) or S3 UUID) are downloaded, then uploaded to Comfy input.
    if _looks_like_remote_image_ref(ref):
        local_path = download_input(ref)
        return upload_local_image_to_comfy_input(
            local_path, server_address, subfolder=subfolder
        )

    # Existing local filesystem path: upload.
    abs_path = osp.abspath(ref)
    if osp.isfile(abs_path):
        return upload_local_image_to_comfy_input(
            abs_path, server_address, subfolder=subfolder
        )

    # React UI storage rel path (under DEFAULT_STORAGE_ROOT): resolve then upload.
    try:
        from services.character_storage import DEFAULT_STORAGE_ROOT

        rel = Path(ref)
        target = (DEFAULT_STORAGE_ROOT / rel).resolve()
        root = DEFAULT_STORAGE_ROOT.resolve()
        if (root == target or root in target.parents) and target.is_file():
            return upload_local_image_to_comfy_input(
                str(target), server_address, subfolder=subfolder
            )
    except Exception:
        pass

    # Otherwise treat as already a Comfy input ref (e.g. "subfolder/name.png") and return as-is.
    return ref


def resolve_to_comfy_video_file_ref(
    video_ref: str,
    server_address: str,
    *,
    subfolder: str = "anime2026_pose_keypoint_video_inputs",
) -> str:
    """
    Resolve a video reference to a ComfyUI LoadVideo ``file`` input (basename or subfolder/name).
    """
    ref = str(video_ref or "").strip()
    if not ref:
        raise ValueError("video_ref is empty")

    if _looks_like_remote_image_ref(ref):
        local_path = download_video_input(ref)
        return upload_local_asset_to_comfy_input(
            local_path, server_address, subfolder=subfolder
        )

    abs_path = osp.abspath(ref)
    if osp.isfile(abs_path):
        return upload_local_asset_to_comfy_input(
            abs_path, server_address, subfolder=subfolder
        )

    try:
        from services.character_storage import DEFAULT_STORAGE_ROOT

        rel = Path(ref)
        target = (DEFAULT_STORAGE_ROOT / rel).resolve()
        root = DEFAULT_STORAGE_ROOT.resolve()
        if (root == target or root in target.parents) and target.is_file():
            return upload_local_asset_to_comfy_input(
                str(target), server_address, subfolder=subfolder
            )
    except Exception:
        pass

    return ref


def apply_upload_local_paths_to_comfy_in_task(
    task: dict,
    server_address: str,
    *,
    subfolder: str = "anime2026_test_inputs",
) -> None:
    """
    For image_url/image_urls and auxiliary_image_urls entries, replace local
    filesystem paths with Comfy input references uploaded through /upload/image.
    """

    def convert_one(val: str) -> str:
        ref = str(val).strip()
        if not ref or _looks_like_remote_image_ref(ref):
            return ref
        abs_path = osp.abspath(ref)
        if not osp.isfile(abs_path):
            return ref
        return upload_local_image_to_comfy_input(
            abs_path, server_address, subfolder=subfolder
        )

    if "image_urls" in task:
        raw = task["image_urls"]
        if isinstance(raw, str):
            task["image_urls"] = convert_one(raw)
        elif isinstance(raw, list):
            task["image_urls"] = [convert_one(x) for x in raw]
    if "image_url" in task:
        task["image_url"] = convert_one(task["image_url"])
    if "auxiliary_image_urls" in task:
        raw = task["auxiliary_image_urls"]
        if isinstance(raw, list):
            task["auxiliary_image_urls"] = [convert_one(x) for x in raw]

    def convert_video(val: str) -> str:
        ref = str(val).strip()
        if not ref or _looks_like_remote_image_ref(ref):
            return ref
        abs_path = osp.abspath(ref)
        if not osp.isfile(abs_path):
            return ref
        return upload_local_asset_to_comfy_input(
            abs_path, server_address, subfolder=subfolder
        )

    if "video_url" in task:
        task["video_url"] = convert_video(str(task.get("video_url") or ""))


def apply_convert_local_paths_to_urls_in_task(task: dict) -> list[tuple[str, str]]:
    """
    For each image_url / image_urls / auxiliary_image_urls entry, if it is an
    existing local file path, upload via the same path as upload_to_s3 and replace
    with the public URL so download_input can fetch it. Returns (bucket, key)
    pairs to delete after the job.
    """
    to_delete: list[tuple[str, str]] = []

    def convert_one(val: str) -> str:
        val = str(val).strip()
        if _looks_like_remote_image_ref(val):
            return val
        abs_path = osp.abspath(val)
        if not osp.isfile(abs_path):
            return val
        url, bucket, key = _upload_to_s3_impl(abs_path, str(uuid.uuid4()))
        to_delete.append((bucket, key))
        return url

    if "image_urls" in task:
        raw = task["image_urls"]
        if isinstance(raw, str):
            task["image_urls"] = convert_one(raw)
        elif isinstance(raw, list):
            task["image_urls"] = [convert_one(x) for x in raw]
    if "image_url" in task:
        task["image_url"] = convert_one(task["image_url"])
    if "auxiliary_image_urls" in task:
        raw = task["auxiliary_image_urls"]
        if isinstance(raw, list):
            task["auxiliary_image_urls"] = [convert_one(x) for x in raw]

    if "video_url" in task:
        task["video_url"] = convert_one(str(task.get("video_url") or ""))

    return to_delete


def timing_decorator(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        start_time = time.time()
        logger.info("start: %s", func.__name__)
        try:
            result = func(*args, **kwargs)
            logger.info(
                "%s done, spend time: %.4fs", func.__name__, time.time() - start_time
            )
            return result
        except Exception as e:
            logger.error(
                "%s error, spend time: %.4fs, error: %s",
                func.__name__,
                time.time() - start_time,
                str(e),
            )
            raise

    return wrapper


def wait_for_service_ready(
    server_address: str, max_wait_time: int = 120, check_interval: float = 0.1
) -> bool:
    # Optional fast-fail to avoid waiting full time when ComfyUI is down.
    # Example: COMFY_STARTUP_EARLY_FAIL_SECONDS=5
    early_fail_s = float(os.environ.get("COMFY_STARTUP_EARLY_FAIL_SECONDS", "0") or "0")
    effective_max_wait = (
        min(max_wait_time, early_fail_s) if early_fail_s > 0 else max_wait_time
    )
    host, port_str = server_address.split(":")
    port = int(port_str)
    start_time = time.time()
    while time.time() - start_time < effective_max_wait:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(check_interval)
                if sock.connect_ex((host, port)) == 0:
                    logger.info("server %s is ready", server_address)
                    return True
        except Exception as e:
            logger.debug("port check error: %s", e)
        time.sleep(check_interval)
        logger.info(
            "waiting for server %s to start, %.2fs/%ss",
            server_address,
            time.time() - start_time,
            effective_max_wait,
        )
    logger.error(
        "server %s not started (waited %.2fs)",
        server_address,
        time.time() - start_time,
    )
    return False


def _format_comfy_prompt_http_error(body: str, fallback: str) -> str:
    """
    ComfyUI POST /prompt returns 400 with JSON:
    ``{"error": {"type", "message", "details", ...}, "node_errors": {...}}``.
    Prefer ``details`` (per-node validation text) over the short ``message`` alone.
    """
    try:
        err_json = json.loads(body)
    except json.JSONDecodeError:
        return body.strip() or fallback

    lines: list[str] = []
    err_obj = err_json.get("error")
    if isinstance(err_obj, dict):
        etype = err_obj.get("type")
        if etype:
            lines.append(f"type={etype}")
        msg = err_obj.get("message")
        det = err_obj.get("details")
        if msg:
            lines.append(str(msg))
        if det is not None and str(det).strip() and str(det) != str(msg):
            lines.append(str(det))
    elif err_obj is not None:
        lines.append(str(err_obj))

    node_errors = err_json.get("node_errors")
    if isinstance(node_errors, dict) and node_errors:
        shown = 0
        for nid, blob in node_errors.items():
            if shown >= 8:
                lines.append(f"... ({len(node_errors)} node(s) with errors, showing first 8)")
                break
            if not isinstance(blob, dict):
                continue
            ct = blob.get("class_type") or ""
            for r in (blob.get("errors") or [])[:2]:
                if not isinstance(r, dict):
                    continue
                rm = r.get("message") or ""
                rd = r.get("details") or ""
                seg = f"node {nid} ({ct})"
                if rm:
                    seg += f": {rm}"
                if rd:
                    seg += f": {rd}"
                lines.append(seg)
                shown += 1

    out = "\n".join(lines).strip()
    return out or body.strip() or fallback


def task_queue(workflow: dict, server_address: str) -> str:
    if not wait_for_service_ready(server_address):
        raise Exception(f"server {server_address} startup timeout, cannot continue")
    payload = {"prompt": workflow}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(f"http://{server_address}/prompt", data=data)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode("utf-8"))
            return result["prompt_id"]
    except urllib.error.HTTPError as e:
        body = ""
        try:
            if e.fp:
                body = e.fp.read().decode("utf-8")
        except (AttributeError, UnicodeDecodeError):
            pass
        msg = _format_comfy_prompt_http_error(body, str(e))
        if _is_comfy_not_started_message(msg):
            raise RuntimeError(
                "ComfyUI Server Not Started: expected http://"
                f"{server_address}/ to accept /prompt. Start ComfyUI or point "
                "services at the correct address (e.g. COMFY_PORT)."
            ) from e
        raise Exception(f"ComfyUI prompt failed: {msg}") from e


def waiting_for_results(
    prompt_id: str, server_address: str, timeout_seconds: int | None = None
) -> None:
    start = time.time()
    while True:
        if timeout_seconds is not None and (time.time() - start) >= timeout_seconds:
            raise TimeoutError(
                f"Waiting for ComfyUI result timed out after {timeout_seconds}s"
            )
        with urllib.request.urlopen(
            f"http://{server_address}/history/{prompt_id}"
        ) as response:
            history = json.loads(response.read().decode("utf-8"))
            if len(history) > 0:
                break
        time.sleep(0.1)
