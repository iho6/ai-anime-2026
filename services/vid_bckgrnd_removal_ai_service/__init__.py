"""
Video background removal using RobustVideoMatting (RVM).

Self-contained service: no ComfyUI, no RunPod required.
Weights are auto-downloaded on first use via torch.hub (~14 MB for MobileNetV3).
Output is a WebM file with VP9+alpha channel, playable directly in modern browsers.
"""
