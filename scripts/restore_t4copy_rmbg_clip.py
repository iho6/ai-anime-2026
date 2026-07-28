"""One-shot: restore Timeline_4_copy clip_mrn0hwdy_7 RMBG assets from Timeline_4."""

from __future__ import annotations

import shutil
from pathlib import Path

from services.logic import probe_video_meta
from services.timeline_storage import (
    read_manifest,
    timeline_abs_to_rel,
    timeline_clips_dir,
    timeline_rel_to_abs,
    write_manifest,
)

SRC_KEY = "Timeline_4"
DST_KEY = "Timeline_4_copy"
CLIP_ID = "clip_mrn0hwdy_7"
STEM = "clip_a655e9bf4bc44ca6a486e64f63be16b3_rmbg_1784176111"


def main() -> None:
    src_clips = timeline_clips_dir(SRC_KEY)
    dst_clips = timeline_clips_dir(DST_KEY)
    dst_clips.mkdir(parents=True, exist_ok=True)

    suffixes = [
        ".webm",
        ".alpha.mkv",
        ".proxy.webm",
        ".proxy.webm.proxy.json",
        ".proxy.alpha.mkv",
    ]
    copied: list[str] = []
    for suf in suffixes:
        src = src_clips / f"{STEM}{suf}"
        if not src.is_file():
            continue
        dest = dst_clips / src.name
        shutil.copy2(src, dest)
        copied.append(dest.name)
        print("copied", dest.name)

    webm = dst_clips / f"{STEM}.webm"
    alpha = dst_clips / f"{STEM}.alpha.mkv"
    proxy = dst_clips / f"{STEM}.proxy.webm"
    if not webm.is_file() or not alpha.is_file():
        raise SystemExit(f"missing webm/alpha after copy: {webm.exists()=} {alpha.exists()=}")

    meta = probe_video_meta(webm)
    dur = float(meta.get("durationSec") or 0)
    if dur <= 0:
        raise SystemExit(f"bad duration from probe: {meta}")

    m = read_manifest(DST_KEY)
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

    speed = max(0.01, float(clip.get("speed") or 1))
    clip["srcRelPath"] = timeline_abs_to_rel(webm)
    clip["alphaRelPath"] = timeline_abs_to_rel(alpha)
    if proxy.is_file():
        clip["proxyRelPath"] = timeline_abs_to_rel(proxy)
        proxy_alpha = dst_clips / f"{STEM}.proxy.alpha.mkv"
        if proxy_alpha.is_file():
            clip["proxyAlphaRelPath"] = timeline_abs_to_rel(proxy_alpha)
        else:
            clip.pop("proxyAlphaRelPath", None)
    else:
        clip.pop("proxyRelPath", None)
        clip.pop("proxyAlphaRelPath", None)

    clip["inPoint"] = 0
    clip["outPoint"] = dur
    clip["srcDuration"] = dur
    clip["duration"] = dur / speed
    if meta.get("width"):
        clip["naturalW"] = int(meta["width"])
    if meta.get("height"):
        clip["naturalH"] = int(meta["height"])

    write_manifest(DST_KEY, m)
    check = read_manifest(DST_KEY)
    restored = next(
        c
        for t in check["tracks"]
        for c in t["clips"]
        if c.get("id") == CLIP_ID
    )
    print("src", restored.get("srcRelPath"))
    print("alpha", restored.get("alphaRelPath"))
    print("proxy", restored.get("proxyRelPath"))
    print("srcDuration", restored.get("srcDuration"), "duration", restored.get("duration"))
    print("abs ok", timeline_rel_to_abs(restored["srcRelPath"]).is_file())
    print("copied_files", len(copied))


if __name__ == "__main__":
    main()
