"""Build a sequence manifest gallery item (frameSequence strip) from remote frame URLs."""

from __future__ import annotations

from typing import Any

from services.character_storage import (
    DEFAULT_STORAGE_ROOT,
    download_url_to_file,
    ensure_dirs,
    get_character_paths,
    unique_suffix,
)


def gallery_item_from_frame_urls(
    *,
    char_key: str,
    sequence_name: str,
    frame_urls: list[str],
    gallery_subdir_prefix: str,
    error_tag: str,
) -> dict[str, Any]:
    """
    Download ordered frame PNG URLs into ``sequence/<name>/gallery/<prefix>_<id>/``.

    Returns ``{"galleryItem": {...}}`` matching FLF / I2V manifest shape.
    """
    root = DEFAULT_STORAGE_ROOT.resolve()
    seq_folder = get_character_paths(char_key).sequence_dir(sequence_name)
    dir_name = f"{gallery_subdir_prefix.strip().lower()}_{unique_suffix(12)}"
    out_dir = seq_folder / "gallery" / dir_name
    ensure_dirs(out_dir)

    strip: list[dict[str, Any]] = []
    for i, url in enumerate(frame_urls):
        if not isinstance(url, str) or not str(url).strip():
            continue
        dest = out_dir / f"frame_{i + 1:06d}.png"
        u = url.strip()
        try:
            download_url_to_file(u, dest)
        except Exception as ex:
            raise RuntimeError(
                f"{error_tag} frame download failed (index {i}, url={u[:200]}): {ex}"
            ) from ex
        rel = dest.resolve().relative_to(root)
        rel_str = str(rel).replace("\\", "/")
        strip.append({"kind": "image", "relPath": rel_str})

    if not strip:
        raise RuntimeError(f"No frames were downloaded from {error_tag} output.")

    gid = unique_suffix(12)
    sgid = unique_suffix(12)
    gallery_item: dict[str, Any] = {
        "id": gid,
        "relPath": strip[0]["relPath"],
        "frameSequence": {
            "sequenceGroupId": sgid,
            "strip": strip,
            "hidden": [],
        },
    }
    return {"galleryItem": gallery_item}
