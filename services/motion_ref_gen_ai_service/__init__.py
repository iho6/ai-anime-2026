"""
Motion reference generation using KiMoD (nv-tlabs/kimodo).

Self-contained persistent-worker service. KiMoD generates 3D skeletal motion
sequences from text prompts. The service exposes:
  - POST /generate  — run KiMoD, store NPZ + joints.json.gz, return metadata
  - POST /render_frame — matplotlib 3D projection of one pose at a camera angle → PNG
  - GET  /health

Install: SKIP_MOTION_CORRECTION_IN_SETUP=1 pip install -e /path/to/kimodo
Runtime: TEXT_ENCODER_DEVICE=cpu  (cuts GPU VRAM from ~17 GB → <3 GB)
"""
