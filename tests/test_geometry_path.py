"""Geometry path sampling parity (export uses same math)."""

from __future__ import annotations

from services.timeline_export import _sample_geometry_points


def test_sample_rect_has_corners() -> None:
    geometry = {
        "closed": True,
        "points": [
            {"x": 0.2, "y": 0.2},
            {"x": 0.8, "y": 0.2},
            {"x": 0.8, "y": 0.8},
            {"x": 0.2, "y": 0.8},
        ],
    }
    pts = _sample_geometry_points(geometry, samples=8)
    assert len(pts) > 4
    xs = [p[0] for p in pts]
    assert min(xs) <= 0.25
    assert max(xs) >= 0.75
