from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import threading
from pathlib import Path
from queue import Queue
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from pydantic import BaseModel
from fastapi.responses import StreamingResponse

from services import logic
from services.character_storage import sanitize_for_folder, unique_suffix
from .storage_paths import (
    LOCATION_STORAGE_ROOT,
    ensure_path_in_location_archive_root,
    ensure_path_in_new_location_draft_root,
    resolve_location_rel_file,
    resolve_storage_rel_file,
    storage_rel_from_abs,
)

router = APIRouter(tags=["location"])

_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def _location_dir(location_key: str) -> Path:
    key = sanitize_for_folder(location_key)
    return (LOCATION_STORAGE_ROOT / key).resolve()


def _migrate_angle_to_view(location_key: str) -> None:
    """Rename legacy ``angle/`` to ``view/`` once; remap ``angle:`` hidden ids to ``view:``."""
    d = _location_dir(location_key)
    if not d.is_dir():
        return
    angle_p = d / "angle"
    view_p = d / "view"
    if angle_p.is_dir() and not view_p.exists():
        angle_p.rename(view_p)
    hidden = _read_hidden(location_key)
    if not hidden:
        return
    new_h: set[str] = set()
    changed = False
    for h in hidden:
        if h.startswith("angle:"):
            new_h.add("view:" + h.split(":", 1)[1])
            changed = True
        else:
            new_h.add(h)
    if changed:
        _write_hidden(location_key, new_h)


def _ensure_location_dirs(location_key: str) -> Path:
    d = _location_dir(location_key)
    _migrate_angle_to_view(location_key)
    (d / "view").mkdir(parents=True, exist_ok=True)
    (d / "lighting").mkdir(parents=True, exist_ok=True)
    return d


def _base_image_for_location(location_key: str) -> Path | None:
    d = _location_dir(location_key)
    if not d.is_dir():
        return None
    for n in ("base.png", "base.jpg", "base.jpeg", "base.webp"):
        p = d / n
        if p.is_file():
            return p
    for p in sorted(d.iterdir()):
        if p.is_file() and p.suffix.lower() in _IMG_EXTS:
            return p
    return None


def _hidden_file(location_key: str) -> Path:
    return _location_dir(location_key) / "gallery_hidden.json"


def _read_hidden(location_key: str) -> set[str]:
    hf = _hidden_file(location_key)
    if not hf.is_file():
        return set()
    try:
        data = json.loads(hf.read_text(encoding="utf-8"))
        items = data.get("hidden") if isinstance(data, dict) else []
        return {str(x) for x in (items or [])}
    except Exception:
        return set()


def _write_hidden(location_key: str, values: set[str]) -> None:
    hf = _hidden_file(location_key)
    hf.parent.mkdir(parents=True, exist_ok=True)
    hf.write_text(json.dumps({"hidden": sorted(values)}, indent=2), encoding="utf-8")


def _list_section(location_key: str, section: str) -> list[dict[str, str]]:
    d = _location_dir(location_key) / section
    if not d.is_dir():
        return []
    out: list[dict[str, str]] = []
    for p in sorted(d.iterdir()):
        if p.is_file() and p.suffix.lower() in _IMG_EXTS:
            rel = storage_rel_from_abs(str(p))
            out.append(
                {
                    "itemId": f"{section}:{p.name}",
                    "folderKey": section,
                    "relPath": rel,
                }
            )
    return out


@router.get("/location/hub/items")
def location_hub_items() -> list[dict[str, str]]:
    LOCATION_STORAGE_ROOT.mkdir(parents=True, exist_ok=True)
    out: list[dict[str, str]] = []
    for p in sorted(LOCATION_STORAGE_ROOT.iterdir()):
        if not p.is_dir() or p.name.startswith("_"):
            continue
        base = _base_image_for_location(p.name)
        if not base:
            continue
        out.append({"locationKey": p.name, "coverRelPath": storage_rel_from_abs(str(base))})
    return out


@router.post("/location/hub/{location_key}/rename")
def location_hub_rename(location_key: str, body: dict[str, str]) -> dict[str, str]:
    nn = sanitize_for_folder((body.get("newName") or "").strip())
    if not nn:
        raise HTTPException(400, "Name cannot be empty.")
    old = _location_dir(location_key)
    if not old.is_dir():
        raise HTTPException(404, "Location not found.")
    new = _location_dir(nn)
    if new.exists():
        raise HTTPException(400, "Location already exists.")
    old.rename(new)
    return {"newLocationKey": nn}


@router.post("/location/hub/{location_key}/delete")
def location_hub_delete(location_key: str) -> dict[str, bool]:
    d = _location_dir(location_key)
    if d.is_dir():
        shutil.rmtree(d)
    return {"ok": True}


@router.get("/location/hub/{location_key}/cover_candidates")
def location_cover_candidates(location_key: str) -> list[dict[str, str]]:
    d = _location_dir(location_key)
    if not d.is_dir():
        raise HTTPException(404, "Location not found.")
    out: list[dict[str, str]] = []
    _migrate_angle_to_view(location_key)
    for sec in ("view", "lighting"):
        out.extend(_list_section(location_key, sec))
    b = _base_image_for_location(location_key)
    if b:
        out.insert(0, {"itemId": "base", "folderKey": "base", "relPath": storage_rel_from_abs(str(b))})
    return [{"relPath": x["relPath"], "caption": x["itemId"]} for x in out]


@router.post("/location/hub/{location_key}/change_cover")
def location_change_cover(location_key: str, body: dict[str, str]) -> dict[str, bool]:
    rel = (body.get("relPath") or "").strip()
    if not rel:
        raise HTTPException(400, "Missing relPath")
    src = resolve_location_rel_file(rel)
    d = _ensure_location_dirs(location_key)
    ext = src.suffix.lower() or ".png"
    dest = d / f"base{ext}"
    for p in d.glob("base.*"):
        if p.is_file():
            p.unlink()
    shutil.copy2(src, dest)
    return {"ok": True}


class NewLocationGeneratePayload(BaseModel):
    prompt: str


@router.post("/new_location/generate_stream")
async def new_location_generate_stream(payload: NewLocationGeneratePayload) -> StreamingResponse:
    pp = (payload.prompt or "").strip()
    if not pp:
        async def empty_prompt() -> Any:
            yield json.dumps({"type": "error", "detail": "Prompt is required."}) + "\n"
        return StreamingResponse(empty_prompt(), media_type="application/x-ndjson")

    result: dict[str, str] = {}
    errors: list[BaseException] = []
    log_queue: Queue[str | None] = Queue()
    drafts_dir = (LOCATION_STORAGE_ROOT / "_drafts").resolve()
    drafts_dir.mkdir(parents=True, exist_ok=True)

    def worker() -> None:
        def log_cb(line: str) -> None:
            log_queue.put(json.dumps({"type": "log", "line": line}) + "\n")

        try:
            preview_abs, _ = logic.generate_character_base_draft_to_temp(pp, log_cb=log_cb)
            src = Path(preview_abs).resolve()
            ext = src.suffix.lower() or ".png"
            dest = drafts_dir / f"draft_{unique_suffix(12)}{ext}"
            shutil.copy2(src, dest)
            result["preview_abs"] = str(dest)
        except BaseException as e:
            errors.append(e)
        finally:
            log_queue.put(None)

    threading.Thread(target=worker, daemon=True).start()

    async def event_gen() -> Any:
        while True:
            chunk = await asyncio.to_thread(log_queue.get)
            if chunk is None:
                break
            yield chunk
        if errors:
            yield json.dumps({"type": "error", "detail": {"error": str(errors[0])}}) + "\n"
            return
        preview_abs = result.get("preview_abs")
        if not preview_abs:
            yield json.dumps({"type": "error", "detail": {"error": "No preview path after generation."}}) + "\n"
            return
        yield json.dumps({"type": "done", "previewRelPath": storage_rel_from_abs(preview_abs)}) + "\n"

    return StreamingResponse(event_gen(), media_type="application/x-ndjson")


@router.get("/new_location/draft_bases")
def new_location_drafts() -> dict[str, list[str]]:
    d = (LOCATION_STORAGE_ROOT / "_drafts").resolve()
    if not d.is_dir():
        return {"relPaths": []}
    rels = [
        storage_rel_from_abs(str(p))
        for p in sorted(d.iterdir())
        if p.is_file() and p.suffix.lower() in _IMG_EXTS
    ]
    return {"relPaths": rels}


@router.post("/new_location/append_upload")
def new_location_append_upload(file: UploadFile = File(...)) -> dict[str, str]:
    d = (LOCATION_STORAGE_ROOT / "_drafts").resolve()
    d.mkdir(parents=True, exist_ok=True)
    ext = Path(file.filename or "").suffix.lower() or ".png"
    dest = d / f"draft_{unique_suffix(12)}{ext}"
    with open(dest, "wb") as f:
        f.write(file.file.read())
    return {"previewRelPath": storage_rel_from_abs(str(dest))}


@router.post("/new_location/finalize")
def new_location_finalize(body: dict[str, str]) -> dict[str, Any]:
    name = (body.get("locationName") or "").strip()
    rel = (body.get("relPath") or "").strip()
    if not name:
        raise HTTPException(400, "Location name is required.")
    if not rel:
        raise HTTPException(400, "Missing relPath")
    src = resolve_location_rel_file(rel)
    key = sanitize_for_folder(name)
    d = _ensure_location_dirs(key)
    ext = src.suffix.lower() or ".png"
    for p in d.glob("base.*"):
        if p.is_file():
            p.unlink()
    shutil.copy2(src, d / f"base{ext}")
    return {"ok": True, "locationKey": key}


class NewLocationRelPathPayload(BaseModel):
    relPath: str


@router.post("/new_location/discard")
def new_location_discard() -> dict[str, bool]:
    logic.clear_new_location_draft_workspace()
    return {"ok": True}


@router.post("/new_location/remove_draft")
def new_location_remove_draft(payload: NewLocationRelPathPayload) -> dict[str, bool]:
    if not payload.relPath:
        raise HTTPException(400, "Missing relPath")
    sel_abs = resolve_storage_rel_file(payload.relPath)
    ensure_path_in_new_location_draft_root(sel_abs)
    try:
        logic.delete_new_location_draft_file(sel_abs)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@router.post("/new_location/archive_base")
def new_location_archive_base(payload: NewLocationRelPathPayload) -> dict[str, Any]:
    if not payload.relPath:
        raise HTTPException(400, "Missing relPath")
    sel_abs = resolve_storage_rel_file(payload.relPath)
    ensure_path_in_new_location_draft_root(sel_abs)
    try:
        archived_abs = logic.archive_new_location_draft_file(sel_abs)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"archivedRelPath": storage_rel_from_abs(archived_abs)}


@router.get("/new_location/archive")
def new_location_archive_list() -> dict[str, Any]:
    paths = logic.list_location_archive_paths()
    return {"relPaths": [storage_rel_from_abs(p) for p in paths]}


@router.post("/new_location/import_from_archive")
def new_location_import_from_archive(payload: NewLocationRelPathPayload) -> dict[str, Any]:
    if not payload.relPath:
        raise HTTPException(400, "Missing relPath")
    src_abs = resolve_storage_rel_file(payload.relPath)
    ensure_path_in_location_archive_root(src_abs)
    try:
        dest_abs = logic.import_location_archive_file_to_drafts(src_abs)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"previewRelPath": storage_rel_from_abs(dest_abs)}


@router.get("/detail/{location_key}/location/gallery_split")
def location_gallery_split(location_key: str) -> dict[str, Any]:
    _migrate_angle_to_view(location_key)
    lighting = _list_section(location_key, "lighting")
    view_files = _list_section(location_key, "view")
    hidden = _read_hidden(location_key)
    base_path = _base_image_for_location(location_key)
    base_rel: str | None = storage_rel_from_abs(str(base_path)) if base_path else None
    base_entry: list[dict[str, str]] = []
    if base_path:
        base_entry.append(
            {
                "itemId": f"root:{base_path.name}",
                "folderKey": "view",
                "relPath": storage_rel_from_abs(str(base_path)),
            }
        )
    view_all = [*base_entry, *view_files]
    hidden_items = [x for x in [*view_all, *lighting] if x["itemId"] in hidden]
    view_vis = [x for x in view_all if x["itemId"] not in hidden]
    lighting_vis = [x for x in lighting if x["itemId"] not in hidden]
    return {
        "view": view_vis,
        "lighting": lighting_vis,
        "hidden": hidden_items,
        "baseRelPath": base_rel,
    }


@router.get("/detail/{location_key}/location/angle_groups")
def location_angle_groups(location_key: str) -> list[dict[str, Any]]:
    """Same shape as pose/expression angle_groups (global angle catalog)."""
    _ = location_key
    groups = logic.grouped_angle_ids()
    max_id = 95
    covered = {aid for _title, ids in groups for aid in ids}
    missing = [i for i in range(max_id + 1) if i not in covered]
    if missing:
        groups = list(groups) + [("Other", missing)]
    if not groups:
        groups = [(f"Angles 0–{max_id}", list(range(max_id + 1)))]
    return [
        {
            "title": t,
            "angleIds": ids,
            "angles": [{"id": aid, "label": logic.angle_ui_label(aid) or f"Angle {aid}"} for aid in ids],
        }
        for t, ids in groups
    ]


@router.post("/detail/{location_key}/location/save_view_copy")
async def location_save_view_copy(location_key: str, file: UploadFile = File(...)) -> dict[str, str]:
    ext = Path(file.filename or "").suffix.lower() or ".png"
    view_root = _ensure_location_dirs(location_key) / "view"
    dest = view_root / f"view_{unique_suffix(12)}{ext}"
    dest.write_bytes(await file.read())
    return {"relPath": storage_rel_from_abs(str(dest))}


@router.post("/detail/{location_key}/location/generate_angles")
async def location_generate_angles(location_key: str, request: Request) -> StreamingResponse:
    form = await request.form()
    raw_ids = form.get("angle_ids")
    if not raw_ids or not str(raw_ids).strip():
        async def bad_req() -> Any:
            yield json.dumps({"type": "error", "detail": "angle_ids required"}) + "\n"

        return StreamingResponse(bad_req(), media_type="application/x-ndjson")

    try:
        parsed_ids = json.loads(str(raw_ids))
        if not isinstance(parsed_ids, list):
            raise ValueError("angle_ids must be a JSON array")
        angle_ids_int = [int(x) for x in parsed_ids]
    except Exception as e:
        async def bad_json() -> Any:
            yield json.dumps({"type": "error", "detail": str(e)}) + "\n"

        return StreamingResponse(bad_json(), media_type="application/x-ndjson")

    input_rel_path = (str(form.get("input_rel_path") or "")).strip()
    upload_files = form.getlist("files")
    tmp_paths: list[Path] = []

    for uf in upload_files:
        if not isinstance(uf, UploadFile) or not uf.filename:
            continue
        suffix = Path(uf.filename).suffix.lower() or ".png"
        data = await uf.read()
        if not data:
            continue
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        tmp.write(data)
        tmp.close()
        tmp_paths.append(Path(tmp.name))

    input_abs: str | None = None
    if tmp_paths:
        input_abs = str(tmp_paths[0].resolve())
    elif input_rel_path:
        p = resolve_location_rel_file(input_rel_path)
        input_abs = str(p.resolve())
    else:
        base = _base_image_for_location(location_key)
        if base and base.is_file():
            input_abs = str(base.resolve())

    if not input_abs:
        for p in tmp_paths:
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass
        async def no_input() -> Any:
            yield json.dumps({"type": "error", "detail": "No input image (upload, input_rel_path, or base)"}) + "\n"

        return StreamingResponse(no_input(), media_type="application/x-ndjson")

    errors: list[BaseException] = []
    log_queue: Queue[str | None] = Queue()

    def worker() -> None:
        def log_cb(line: str) -> None:
            log_queue.put(json.dumps({"type": "log", "line": line}) + "\n")

        try:
            logic.generate_multi_angle_subset_for_location(
                location_key,
                angle_ids_int,
                input_abs,
                log_cb=log_cb,
            )
        except BaseException as e:
            errors.append(e)
        finally:
            log_queue.put(None)
            for p in tmp_paths:
                try:
                    p.unlink(missing_ok=True)
                except OSError:
                    pass

    threading.Thread(target=worker, daemon=True).start()

    async def event_gen() -> Any:
        while True:
            chunk = await asyncio.to_thread(log_queue.get)
            if chunk is None:
                break
            yield chunk
        if errors:
            yield json.dumps({"type": "error", "detail": {"error": str(errors[0])}}) + "\n"
            return
        yield json.dumps({"type": "done", "ok": True}) + "\n"

    return StreamingResponse(event_gen(), media_type="application/x-ndjson")


@router.post("/detail/{location_key}/location/generate")
def location_generate(location_key: str, body: dict[str, str]) -> dict[str, str]:
    sec = (body.get("section") or "view").strip().lower()
    prompt = (body.get("prompt") or "").strip()
    if sec not in {"view", "lighting"}:
        raise HTTPException(400, "section must be view or lighting")
    if not prompt:
        raise HTTPException(400, "prompt required")
    d = _ensure_location_dirs(location_key) / sec
    preview_abs, _ = logic.generate_character_base_draft_to_temp(prompt)
    src = Path(preview_abs).resolve()
    ext = src.suffix.lower() or ".png"
    dest = d / f"{sec}_{unique_suffix(12)}{ext}"
    shutil.copy2(src, dest)
    return {"relPath": storage_rel_from_abs(str(dest))}


@router.post("/detail/{location_key}/location/hide")
def location_hide(location_key: str, body: dict[str, Any]) -> dict[str, bool]:
    item_ids = [str(x) for x in (body.get("itemIds") or [])]
    hidden = _read_hidden(location_key)
    hidden.update(item_ids)
    _write_hidden(location_key, hidden)
    return {"ok": True}


@router.post("/detail/{location_key}/location/unhide")
def location_unhide(location_key: str, body: dict[str, Any]) -> dict[str, bool]:
    item_ids = {str(x) for x in (body.get("itemIds") or [])}
    hidden = _read_hidden(location_key)
    hidden.difference_update(item_ids)
    _write_hidden(location_key, hidden)
    return {"ok": True}


@router.post("/detail/{location_key}/location/delete")
def location_delete_items(location_key: str, body: dict[str, Any]) -> dict[str, bool]:
    ids = [str(x) for x in (body.get("itemIds") or [])]
    d = _location_dir(location_key)
    for iid in ids:
        parts = iid.split(":", 1)
        if len(parts) != 2:
            continue
        sec, fn = parts
        root = d.resolve()
        if sec == "root":
            p = (d / fn).resolve()
        else:
            p = (d / sec / fn).resolve()
        if root != p and root not in p.parents:
            continue
        if p.is_file():
            p.unlink()
    hidden = _read_hidden(location_key)
    hidden.difference_update(ids)
    _write_hidden(location_key, hidden)
    return {"ok": True}


@router.post("/detail/{location_key}/location/ai_edit")
def location_ai_edit(location_key: str, body: dict[str, str]) -> dict[str, str]:
    rel = (body.get("sourceRelPath") or "").strip()
    prompt = (body.get("promptText") or "").strip()
    sec = (body.get("section") or "").strip().lower()
    if sec not in {"view", "lighting"}:
        raise HTTPException(400, "section must be view or lighting")
    if not rel:
        raise HTTPException(400, "sourceRelPath required")
    if not prompt:
        raise HTTPException(400, "promptText required")
    src = resolve_location_rel_file(rel)
    tmp = logic.ai_edit_image_inline_to_temp_file(
        input_image_abs_path=str(src),
        prompt_text=prompt,
    )
    try:
        d = _ensure_location_dirs(location_key) / sec
        ext = Path(tmp).suffix.lower() or src.suffix.lower() or ".png"
        dest = d / f"{sec}_{unique_suffix(12)}{ext}"
        shutil.copy2(tmp, dest)
    finally:
        Path(tmp).unlink(missing_ok=True)
    return {"relPath": storage_rel_from_abs(str(dest))}

