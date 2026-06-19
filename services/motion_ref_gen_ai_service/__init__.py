"""
Motion reference generation using KiMoD (nv-tlabs/kimodo).

Self-contained persistent-worker service. KiMoD generates 3D skeletal motion
sequences from text prompts. The service exposes:
  - POST /generate  — run KiMoD, store NPZ + joints.json.gz, return metadata
  - GET  /health

Shots are captured as a WebGL screenshot of the live client viewer, so the
worker no longer renders frames server-side.

Install: pip install -e /path/to/kimodo  (requires cmake, build-essential, python{X.Y}-dev)

Runtime:
  - Text encoder auto-starts on first motion-gen (headless Gradio, port 9550).
  - TEXT_ENCODER_DEVICE=cuda when GPU available (override with cpu for lower VRAM).
  - KIMODO_TEXT_ENCODER_READY_TIMEOUT=600 (first Llama load).
  - KIMODO_MOTION_WORKER_READY_TIMEOUT=300 (motion model load).
  Manual encoder: python -m kimodo.scripts.run_text_encoder_server --headless
"""
