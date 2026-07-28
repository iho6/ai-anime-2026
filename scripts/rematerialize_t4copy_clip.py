"""One-shot: rematerialize Timeline_4_copy clip_mrn0hwdy_7 from sequence gallery."""

from __future__ import annotations

from pathlib import Path

from services.logic import materialize_sequence_to_timeline_clip, remove_video_background_rmbg
from services.timeline_proxy import ensure_clip_proxy
from services.timeline_storage import read_manifest, timeline_clips_dir, write_manifest
from ui.api.timeline_router import _timeline_video_clip_result

KEY = "Timeline_4_copy"
CLIP_ID = "clip_mrn0hwdy_7"


def main() -> None:
    m = read_manifest(KEY)
    clip = None
    for t in m.get("tracks") or []:
        for c in t.get("clips") or []:
            if c.get("id") == CLIP_ID:
                clip = c
                break
        if clip:
            break
    if not clip:
        raise SystemExit(f"clip {CLIP_ID} not found")

    src = clip.get("source") or {}
    char_key = str(src.get("charKey") or "").strip()
    sequence_name = str(src.get("sequenceName") or "").strip()
    gallery_item_id = str(src.get("galleryItemId") or "").strip()
    if not char_key or not sequence_name or not gallery_item_id:
        raise SystemExit("clip missing source char/sequence/galleryItemId")

    had_alpha = bool(str(clip.get("alphaRelPath") or "").strip())
    print("had_alpha", had_alpha, "source", char_key, sequence_name, gallery_item_id)

    info = materialize_sequence_to_timeline_clip(
        char_key,
        sequence_name,
        gallery_item_id,
        timeline_clips_dir(KEY),
        log_cb=print,
    )
    clip_res = _timeline_video_clip_result(
        info["absPath"],
        width=info.get("width") or 0,
        height=info.get("height") or 0,
        durationSec=float(info.get("durationSec") or 0),
        fps=float(info.get("fps") or 0),
        frames=int(info.get("frames") or 0),
    )
    print("materialized", clip_res)

    if had_alpha and not clip_res.get("alphaRelPath"):
        print("Running RMBG…")
        try:
            out = Path(timeline_clips_dir(KEY)) / f"{Path(info['absPath']).stem}_rmbg.webm"
            r = remove_video_background_rmbg(info["absPath"], out, log_cb=print)
            out_abs = str(r.get("absPath") or out)
            clip_res = _timeline_video_clip_result(
                out_abs,
                width=r.get("width") or 0,
                height=r.get("height") or 0,
                durationSec=float(r.get("durationSec") or 0),
                fps=float(r.get("fps") or 0),
                frames=int(r.get("frames") or 0),
            )
            print("after rmbg", clip_res)
        except Exception as ex:
            print(
                "RMBG failed (will apply opaque materialize without alpha):",
                ex,
            )

    dur = float(clip_res.get("durationSec") or 0)
    clip["srcRelPath"] = clip_res["srcRelPath"]
    if clip_res.get("alphaRelPath"):
        clip["alphaRelPath"] = clip_res["alphaRelPath"]
    else:
        clip.pop("alphaRelPath", None)
    clip.pop("proxyRelPath", None)
    clip.pop("proxyAlphaRelPath", None)
    if dur > 0:
        clip["inPoint"] = 0
        clip["outPoint"] = dur
        clip["srcDuration"] = dur
        speed = max(0.01, float(clip.get("speed") or 1))
        clip["duration"] = dur / speed
    if clip_res.get("width"):
        clip["naturalW"] = clip_res["width"]
    if clip_res.get("height"):
        clip["naturalH"] = clip_res["height"]

    pf = ensure_clip_proxy(clip)
    if pf:
        clip.update(pf)
        if str(pf.get("proxyRelPath") or "").lower().endswith(".webm"):
            clip.pop("proxyAlphaRelPath", None)

    write_manifest(KEY, m)
    print(
        "UPDATED",
        CLIP_ID,
        "src",
        clip.get("srcRelPath"),
        "alpha",
        clip.get("alphaRelPath"),
        "proxy",
        clip.get("proxyRelPath"),
        "dur",
        clip.get("duration"),
    )


if __name__ == "__main__":
    main()
