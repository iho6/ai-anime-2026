"""Tests for geometry/text clip export compositing."""

from __future__ import annotations

import numpy as np
import pytest

from services.timeline_export import _draw_geometry_on_canvas, _draw_text_on_canvas, _has_exportable_video


def _manifest_with_geometry_and_text() -> dict:
    return {
        "version": 2,
        "fps": 24,
        "previewAspect": "16:9",
        "tracks": [
            {
                "id": "v1",
                "name": "Video 1",
                "kind": "video",
                "clips": [
                    {
                        "id": "g1",
                        "type": "geometry",
                        "srcRelPath": "",
                        "start": 0,
                        "inPoint": 0,
                        "outPoint": 1,
                        "speed": 1,
                        "duration": 1,
                        "naturalW": 1000,
                        "naturalH": 1000,
                        "transform": {"x": 0, "y": 0, "scale": 0.5},
                        "geometry": {
                            "template": "rect",
                            "closed": True,
                            "points": [
                                {"x": 0.2, "y": 0.2},
                                {"x": 0.8, "y": 0.2},
                                {"x": 0.8, "y": 0.8},
                                {"x": 0.2, "y": 0.8},
                            ],
                            "fill": "#ffffff",
                            "stroke": {"color": "#000000", "width": 4},
                        },
                    },
                    {
                        "id": "t1",
                        "type": "text",
                        "srcRelPath": "",
                        "start": 0,
                        "inPoint": 0,
                        "outPoint": 1,
                        "speed": 1,
                        "duration": 1,
                        "naturalW": 1000,
                        "naturalH": 1000,
                        "transform": {"x": 0.2, "y": 0.2, "scale": 0.3},
                        "text": {
                            "content": "Hi",
                            "fontFamilyId": "inter",
                            "fontWeight": 400,
                            "fontStyle": "normal",
                            "fontSize": 48,
                            "color": "#ff0000",
                            "align": "center",
                        },
                    },
                ],
            }
        ],
    }


def test_has_exportable_video_with_geometry_text() -> None:
    assert _has_exportable_video(_manifest_with_geometry_and_text()) is True


def test_draw_geometry_and_text_on_canvas() -> None:
    from PIL import Image

    manifest = _manifest_with_geometry_and_text()
    track = manifest["tracks"][0]
    geom_clip = track["clips"][0]
    text_clip = track["clips"][1]
    frame_w, frame_h = 1920, 1080
    rect = {"left": 480.0, "top": 270.0, "width": 960.0, "height": 540.0}

    canvas = Image.new("RGBA", (frame_w, frame_h), (0, 0, 0, 255))
    _draw_geometry_on_canvas(canvas, geom_clip, rect, 0, 1.0)
    _draw_text_on_canvas(canvas, text_clip, rect, 0, 1.0)

    arr = np.asarray(canvas)
    assert arr.mean() > 5, "composited canvas should not be all black"
