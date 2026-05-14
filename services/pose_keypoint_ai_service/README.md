# Pose keypoint AI service (SDPose)

Draws whole-body pose keypoints on **images** or **videos** using ComfyUI workflows under `workflows/` (SDPose checkpoint + `ResizeImageMaskNode` + `SDPoseKeypointExtractor` + `SDPoseDrawKeypoints`).

## Input (RunPod `input` object)

Use **either** images **or** one video (not both).

### Images

- `image_url` — single string, or  
- `image_urls` — non-empty list of strings (or a single string treated as one ref).

Same resolution rules as other services: `http(s)`, S3 UUID, local path, or character storage relative path where applicable.

### Video

- `video_url` — one video ref (same URL/path/UUID rules as images, with video download helpers in `services.utils`).

Optional:

- `export_frame` or `export_frames` — if true, output **per-frame PNGs** (keypoint overlay) instead of a single **keypoint video** (`mp4`/etc.).

## Response

```json
{
  "created_at": 1234567890,
  "queued_at": 1234567890,
  "results": [],
  "error": null
}
```

Each `results` item is one of:

- **Image job:** `{ "kind": "image", "url": "...", "input_index": 0, "source": "...", "filename": "...", "subfolder": "..." }`
- **Video job:** `{ "kind": "video", "url": "...", "source": "..." }`
- **Frames job:** `{ "kind": "frames", "urls": ["..."], "frame_count": N, "source": "..." }`

If `error` is set, processing stopped on that failure.

## Models

From repository root:

```bash
python utils/download_models.py --pose-keypoint [--hf-token YOUR_TOKEN]
```

Checkpoint: `models/checkpoints/sdpose_wholebody_fp16.safetensors`.

## Local test mode

Start ComfyUI on port 8188, then:

```bash
python -m services.pose_keypoint_ai_service.serverless --test-mode --enable-default --image-url /path/to/photo.jpg
```

Video:

```bash
python -m services.pose_keypoint_ai_service.serverless --test-mode --enable-default --video-url /path/to/clip.mp4
```

Per-frame PNGs instead of video:

```bash
python -m services.pose_keypoint_ai_service.serverless --test-mode --enable-default --video-url /path/to/clip.mp4 --export-frame
```

## Docker (optional)

From repo root:

```bash
bash services/pose_keypoint_ai_service/deployment/buildspec.sh
```

Image default: `anime2026/pose_keypoint_ai_service`. Container entrypoint starts ComfyUI with `--enable-pose-keypoint` and the serverless worker.

## Files

| File | Role |
|------|------|
| `core.py` | Workflow selection, Comfy queue, history → URLs |
| `serverless.py` | RunPod handler + CLI |
| `workflows/*.json` | API-format graphs only (`*_non_api` templates live under `workflow_library/` if needed) |
