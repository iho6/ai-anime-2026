import mimetypes
import os

# PLACE HOLDERS, currently testing. Add your own s3 path for use.
S3_OUTPUT_BUCKET = os.environ.get("S3_OUTPUT_BUCKET", "anime2026")
S3_OUTPUT_PREFIX = os.environ.get("S3_OUTPUT_PREFIX", "images/")
S3_INPUT_BUCKET = os.environ.get("S3_INPUT_BUCKET", "anime2026")
S3_INPUT_PREFIX = os.environ.get("S3_INPUT_PREFIX", "images/")

AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
S3_PUBLIC_URL_BASE = os.environ.get(
    "S3_PUBLIC_URL_BASE",
    "https://anime2026.s3.ap-southeast-2.amazonaws.com/images",
)

DOWNLOAD_CACHE_FILE = os.environ.get(
    "SERVICES_DOWNLOAD_CACHE_FILE", "services/download_cache.jsonl"
).replace("\\", "/")

LOCAL_INPUT_DIR = os.environ.get("LOCAL_INPUT_DIR", "comfyui/input")
LOCAL_OUTPUT_DIR = os.environ.get("LOCAL_OUTPUT_DIR", "comfyui/output")

CACHE_MAX_AGE = 31536000
TIMEOUT = int(os.environ.get("COMFY_TASK_TIMEOUT", "3000"))

MIME_TO_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/tiff": "tif",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "image/avif": "avif",
    "image/heif": "heif",
    "image/heic": "heic",
}
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")
mimetypes.add_type("image/heif", ".heif")
mimetypes.add_type("image/heic", ".heic")
