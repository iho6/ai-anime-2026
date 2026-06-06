from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path
from queue import Queue
from typing import Any
import threading
import urllib.request
import json

from fastapi import File, Form, FastAPI, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from starlette.middleware.cors import CORSMiddleware


# Ensure repo root is on sys.path when running from this subfolder.
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from services import logic  # noqa: E402
from services.utils import summarize_comfy_history_entry  # noqa: E402

from ui.api.dataset_router import router as dataset_router  # noqa: E402
from ui.api.sequence_router import router as sequence_router  # noqa: E402
from ui.api.expression_router import router as expression_router  # noqa: E402
from ui.api.pose_router import router as pose_router  # noqa: E402
from ui.api.location_router import router as location_router  # noqa: E402
from ui.api.shot_router import router as shot_router  # noqa: E402
from ui.api.reference_router import router as reference_router  # noqa: E402
from ui.api.timeline_router import router as timeline_router  # noqa: E402
from ui.api.motion_ref_router import router as motion_ref_router  # noqa: E402
from ui.api.storage_paths import (  # noqa: E402
    ensure_path_in_character_archive_root,
    ensure_path_in_new_character_draft_root,
    ensure_path_under_character,
    resolve_storage_rel_file,
    storage_rel_from_abs,
)
from ui.api.ws_streaming import (  # noqa: E402
    pump_startup_log_queue,
    run_with_log_stream,
    safe_send_json,
)


def _cors_allow_origins() -> list[str]:
    base = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ]
    extra = (os.environ.get("REACT_UI_CORS_ORIGINS") or "").strip()
    if not extra:
        return base
    merged = list(base)
    for part in extra.split(","):
        p = part.strip()
        if p and p not in merged:
            merged.append(p)
    return merged


app = FastAPI(title="anime2026 React UI API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(pose_router)
app.include_router(expression_router)
app.include_router(dataset_router)
app.include_router(sequence_router)
app.include_router(location_router)
app.include_router(shot_router)
app.include_router(reference_router)
app.include_router(timeline_router)
app.include_router(motion_ref_router)

@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "cwd": str(Path.cwd()),
        "python": sys.version.split()[0],
        "pid": os.getpid(),
    }


class StartupStartPayload(BaseModel):
    hf_token: str
    github_pat: str


class HfTokenUpdatePayload(BaseModel):
    hf_token: str


@app.post("/startup/start")
def startup_start(payload: StartupStartPayload) -> dict[str, Any]:
    """
    Stub endpoint.

    The full implementation will:
    - stream log lines over WebSocket while setup/downloads run
    - call `logic.run_startup_setup_and_launch(...)` with a log callback
    """
    return {"ok": True}


@app.get("/settings/hf_token")
def settings_get_hf_token() -> dict[str, str]:
    token = (os.environ.get("HF_TOKEN") or "").strip()
    return {"hf_token": token}


@app.post("/settings/hf_token")
def settings_update_hf_token(payload: HfTokenUpdatePayload) -> dict[str, Any]:
    token = (payload.hf_token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="hf_token is required")
    os.environ["HF_TOKEN"] = token
    return {"ok": True}


@app.websocket("/startup/ws")
async def startup_ws(ws: WebSocket) -> None:
    """
    Stub WebSocket.

    The full implementation will accept messages from the client and then stream log output.
    """
    await ws.accept()
    try:
        # Expect first message:
        #   {"type":"start","hf_token":"...","github_pat":"..."}
        msg = await ws.receive_json()
        if msg.get("type") != "start":
            await safe_send_json(
                ws, {"type": "error", "error": "Expected start message"}
            )
            return
        token = (msg.get("hf_token") or "").strip()
        if not token:
            await safe_send_json(ws, {"type": "error", "error": "Missing hf_token"})
            return
        github_pat = (msg.get("github_pat") or "").strip()
        if not github_pat:
            await safe_send_json(ws, {"type": "error", "error": "Missing github_pat"})
            return
        os.environ["GITHUB_PAT"] = github_pat

        loop = asyncio.get_running_loop()
        q: asyncio.Queue[str] = asyncio.Queue()
        startup_t0 = time.monotonic()

        def _elapsed_prefix() -> str:
            elapsed = max(0.0, time.monotonic() - startup_t0)
            m, s = divmod(int(elapsed), 60)
            h, m = divmod(m, 60)
            return f"[+{h:02d}:{m:02d}:{s:02d}]"

        def log_cb(line: str) -> None:
            # SharedLogStream only recognizes replace-last when the magic token is first.
            # Put elapsed time after the token so tqdm progress updates one line in the UI.
            rp = logic.LOG_UI_REPLACE_LAST_PREFIX
            if line.startswith(rp):
                rest = line[len(rp) :]
                loop.call_soon_threadsafe(
                    q.put_nowait, f"{rp}{_elapsed_prefix()} {rest}"
                )
            else:
                loop.call_soon_threadsafe(
                    q.put_nowait, f"{_elapsed_prefix()} {line}"
                )

        loop.call_soon_threadsafe(q.put_nowait, f"{_elapsed_prefix()} Startup requested.")

        err: str | None = None

        def runner() -> None:
            nonlocal err
            try:
                logic.run_startup_setup_and_launch(
                    hf_token=token, github_pat=github_pat, log_cb=log_cb
                )
            except Exception as e:
                err = str(e)
            finally:
                loop.call_soon_threadsafe(q.put_nowait, "__DONE__")

        t = threading.Thread(target=runner, daemon=True)
        t.start()

        still_connected = await pump_startup_log_queue(ws, q)
        if not still_connected:
            return

        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True})
    except WebSocketDisconnect:
        return


@app.get("/assets/storage/{rel_path:path}")
def storage_asset(rel_path: str) -> FileResponse:
    """
    Serve local UI assets from `storage/characters/...`.
    Used by the React UI to render cover thumbnails and generated images.
    """
    p = resolve_storage_rel_file(rel_path)
    return FileResponse(str(p))


@app.get("/assets/storage_download/{rel_path:path}")
def storage_asset_download(rel_path: str) -> FileResponse:
    """
    Force download of local UI assets from `storage/characters/...`.
    This is separate from `/assets/storage/...` so inline `<img>` rendering still works.
    """
    p = resolve_storage_rel_file(rel_path)
    name = Path(p).name
    return FileResponse(
        str(p),
        filename=name,
        headers={"Content-Disposition": f'attachment; filename="{name}"'},
    )


def _cover_candidates_for_char(char_key: str) -> list[dict[str, str]]:
    paths = logic.list_character_image_paths_deduped(char_key)
    caps = logic.character_image_chooser_captions(char_key, paths)
    out: list[dict[str, str]] = []
    for p, c in zip(paths, caps):
        out.append({"relPath": storage_rel_from_abs(p), "caption": c})
    return out


class HubCharacterTile(BaseModel):
    charKey: str
    coverRelPath: str


@app.get("/hub/characters", response_model=list[HubCharacterTile])
def hub_characters() -> list[HubCharacterTile]:
    items, _keys = logic.character_cover_gallery_payload()
    out: list[HubCharacterTile] = []
    # `character_cover_gallery_payload` returns (cover_path, char_key) pairs.
    for cover_abs, char_key in items:
        if not cover_abs:
            continue
        out.append(
            HubCharacterTile(
                charKey=char_key,
                coverRelPath=storage_rel_from_abs(cover_abs),
            )
        )
    return out


@app.get("/hub/{char_key}/cover", response_model=dict[str, str])
def hub_cover(char_key: str) -> dict[str, str]:
    cover_path = logic.character_base_image_path(char_key)
    if not cover_path:
        raise HTTPException(status_code=404, detail="No cover found")
    detail_path = logic.character_detail_gate_preview_path(char_key)
    if not detail_path:
        raise HTTPException(status_code=404, detail="No cover found")
    return {
        "relPath": storage_rel_from_abs(str(cover_path)),
        "detailPreviewRelPath": storage_rel_from_abs(str(detail_path)),
    }


@app.get("/hub/{char_key}/cover_candidates", response_model=list[dict[str, str]])
def hub_cover_candidates(char_key: str) -> list[dict[str, str]]:
    if not char_key:
        raise HTTPException(status_code=400, detail="Missing char_key")
    return _cover_candidates_for_char(char_key)


class RenamePayload(BaseModel):
    newName: str


@app.post("/hub/{char_key}/rename")
def hub_rename(char_key: str, payload: RenamePayload) -> dict[str, str]:
    nn = (payload.newName or "").strip()
    if not nn:
        raise HTTPException(status_code=400, detail="Name cannot be empty.")
    new_key = logic.rename_character_folder(char_key, nn)
    return {"newCharKey": new_key}


class RepairPathsPayload(BaseModel):
    knownOldKeys: list[str] | None = None


@app.post("/hub/{char_key}/repair-paths")
def hub_repair_paths(
    char_key: str, payload: RepairPathsPayload | None = None
) -> dict[str, Any]:
    """
    Rewrite every stored path/id under ``char_key`` whose first segment is not the
    current folder name. Useful after renaming a character folder outside the app
    (e.g. via SSH copy) to realign ``relPath`` / flat gallery ids.
    """
    old_keys = payload.knownOldKeys if payload is not None else None
    try:
        return logic.repair_character_stored_paths(char_key, old_keys)
    except ValueError as ex:
        raise HTTPException(status_code=400, detail=str(ex)) from ex


@app.post("/hub/{char_key}/delete")
def hub_delete(char_key: str) -> dict[str, Any]:
    if not char_key:
        raise HTTPException(status_code=400, detail="Missing char_key")
    logic.delete_character_folder(char_key)
    return {"ok": True}


class ChangeCoverPayload(BaseModel):
    # relPath under DEFAULT_STORAGE_ROOT
    relPath: str


@app.post("/hub/{char_key}/change_cover")
def hub_change_cover(char_key: str, payload: ChangeCoverPayload) -> dict[str, Any]:
    if not payload.relPath:
        raise HTTPException(status_code=400, detail="Missing relPath")
    sel_abs = str(resolve_storage_rel_file(payload.relPath))
    logic.set_character_cover_from_image(char_key, sel_abs)
    return {"ok": True}


@app.post("/hub/{char_key}/ensure_cover")
def hub_ensure_cover(char_key: str) -> dict[str, Any]:
    """If ``base.*`` is missing, set cover from the first available character image."""
    if not char_key:
        raise HTTPException(status_code=400, detail="Missing char_key")
    reassigned = logic.reassign_character_cover_if_invalid(char_key)
    return {"ok": True, "reassigned": reassigned}


@app.websocket("/hub/{char_key}/closeup_wizard/ws")
async def hub_closeup_wizard_ws(ws: WebSocket, char_key: str) -> None:
    await ws.accept()
    try:
        msg = await ws.receive_json()
        job = (msg.get("job") or "").strip()
        session_id = (msg.get("sessionId") or "").strip()
        if job == "start":
            result = logic.start_closeup_wizard(char_key)
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
            return
        if not session_id:
            raise ValueError("sessionId required")
        if job == "generate_current":
            result, err = await run_with_log_stream(
                ws,
                lambda log_cb: logic.generate_current_closeup_wizard(
                    session_id, force=False, log_cb=log_cb
                ),
            )
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
            return
        if job == "regenerate_current":
            result, err = await run_with_log_stream(
                ws,
                lambda log_cb: logic.generate_current_closeup_wizard(
                    session_id, force=True, log_cb=log_cb
                ),
            )
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
            return
        if job == "save_current_and_next":
            result, err = await run_with_log_stream(
                ws,
                lambda log_cb: logic.save_current_closeup_and_advance(
                    session_id, log_cb=log_cb
                ),
            )
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
            return
        if job == "save_current":
            result = logic.save_current_closeup_only(session_id)
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
            return
        if job == "go_last_angle":
            result = logic.go_last_closeup_wizard(session_id)
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
            return
        if job == "go_next_angle":
            result = logic.go_next_closeup_wizard(session_id)
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
            return
        if job == "save_all":
            result = logic.save_all_closeup_wizard(session_id)
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
            return
        if job == "close":
            logic.close_closeup_wizard(session_id)
            await safe_send_json(ws, {"type": "done", "ok": True, "result": {"ok": True}})
            return
        await safe_send_json(
            ws, {"type": "done", "ok": False, "error": f"Unknown job: {job!r}"}
        )
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


class NewCharacterGeneratePayload(BaseModel):
    prompt: str
    name: str | None = None


def _new_character_anime_gen_error_detail(e: logic.AnimeGenServiceError) -> dict[str, Any]:
    detail: dict[str, Any] = {"error": str(e)}
    if getattr(e, "prompt_id", None):
        detail["prompt_id"] = e.prompt_id
    if getattr(e, "prompt_index", None) is not None:
        detail["prompt_index"] = e.prompt_index
    pid = getattr(e, "prompt_id", None)
    if isinstance(pid, str) and pid:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:8188/history/{pid}") as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            comfy_hist = json.loads(raw) if raw else {}
            item = (
                comfy_hist.get(pid)
                if isinstance(comfy_hist, dict) and pid in comfy_hist
                else comfy_hist
            ) or {}
            if isinstance(item, dict):
                detail["comfy"] = summarize_comfy_history_entry(item)
            else:
                detail["comfy"] = {"parse_error": "history entry is not a dict"}
        except Exception as fetch_e:
            detail["comfy_fetch_error"] = str(fetch_e)
    return detail


@app.post("/new_character/generate")
def new_character_generate(payload: NewCharacterGeneratePayload) -> dict[str, str]:
    pp = (payload.prompt or "").strip()
    if not pp:
        raise HTTPException(status_code=400, detail="Prompt is required.")
    try:
        preview_abs, _base_abs = logic.generate_character_base_draft_to_temp(pp)
    except logic.AnimeGenServiceError as e:
        raise HTTPException(
            status_code=500, detail=_new_character_anime_gen_error_detail(e)
        ) from e
    return {
        "previewRelPath": storage_rel_from_abs(preview_abs),
        "previewAbsPath": preview_abs,  # debug; frontend can ignore
    }


@app.post("/new_character/generate_stream")
async def new_character_generate_stream(payload: NewCharacterGeneratePayload) -> StreamingResponse:
    """
    NDJSON stream: {"type":"log","line":"..."}* then {"type":"done",...} or {"type":"error","detail":...}.
    """

    pp = (payload.prompt or "").strip()
    if not pp:

        async def empty_prompt() -> Any:
            yield json.dumps({"type": "error", "detail": "Prompt is required."}) + "\n"

        return StreamingResponse(empty_prompt(), media_type="application/x-ndjson")

    result: dict[str, str] = {}
    errors: list[BaseException] = []
    log_queue: Queue[str | None] = Queue()

    def worker() -> None:
        def log_cb(line: str) -> None:
            log_queue.put(json.dumps({"type": "log", "line": line}) + "\n")

        try:
            preview_abs, _base_abs = logic.generate_character_base_draft_to_temp(pp, log_cb=log_cb)
            result["preview_abs"] = preview_abs
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
            err = errors[0]
            if isinstance(err, logic.AnimeGenServiceError):
                d = _new_character_anime_gen_error_detail(err)
                yield json.dumps({"type": "error", "detail": d}) + "\n"
            else:
                yield json.dumps({"type": "error", "detail": {"error": str(err)}}) + "\n"
            return
        preview_abs = result.get("preview_abs")
        if not preview_abs:
            yield json.dumps(
                {"type": "error", "detail": {"error": "No preview path after generation."}}
            ) + "\n"
            return
        yield json.dumps(
            {
                "type": "done",
                "previewRelPath": storage_rel_from_abs(preview_abs),
                "previewAbsPath": preview_abs,
            }
        ) + "\n"

    return StreamingResponse(event_gen(), media_type="application/x-ndjson")


class NewCharacterSaveUploadedPayload(BaseModel):
    name: str


@app.post("/new_character/save_uploaded")
def new_character_save_uploaded(
    name: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    """
    Save a user-uploaded base image under the generated character folder.
    This mirrors the PyQt path that calls `logic.save_uploaded_character_base(...)`.
    """
    nn = (name or "").strip()
    if not nn:
        raise HTTPException(status_code=400, detail="Name is required.")

    # Save to a temp file so `logic.save_uploaded_character_base` can reuse the existing implementation.
    import tempfile

    suffix = Path(file.filename or "").suffix or ".png"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file.file.read())
        tmp.flush()
        tmp_path = Path(tmp.name)

    try:
        dest_abs = logic.save_uploaded_character_base(nn, tmp_path)
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass

    # For the UI, preview == base destination.
    return {
        "previewRelPath": storage_rel_from_abs(dest_abs),
        "charKey": logic.get_character_paths(nn).character_key,
    }


@app.get("/new_character/draft_bases")
def new_character_draft_bases() -> dict[str, Any]:
    paths = logic.list_new_character_draft_paths()
    return {
        "relPaths": [storage_rel_from_abs(p) for p in paths],
    }


class NewCharacterFinalizeFromTempPayload(BaseModel):
    characterName: str
    relPath: str


@app.post("/new_character/finalize")
def new_character_finalize_from_temp(payload: NewCharacterFinalizeFromTempPayload) -> dict[str, Any]:
    nn = (payload.characterName or "").strip()
    if not nn:
        raise HTTPException(status_code=400, detail="Character name is required.")
    if not payload.relPath:
        raise HTTPException(status_code=400, detail="Missing relPath")
    sel_abs = resolve_storage_rel_file(payload.relPath)
    ensure_path_in_new_character_draft_root(sel_abs)
    try:
        logic.finalize_new_character_from_temp(nn, sel_abs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@app.post("/new_character/discard")
def new_character_discard() -> dict[str, Any]:
    logic.clear_new_character_draft_workspace()
    return {"ok": True}


class NewCharacterRelPathPayload(BaseModel):
    relPath: str


@app.post("/new_character/remove_draft")
def new_character_remove_draft(payload: NewCharacterRelPathPayload) -> dict[str, Any]:
    if not payload.relPath:
        raise HTTPException(status_code=400, detail="Missing relPath")
    sel_abs = resolve_storage_rel_file(payload.relPath)
    ensure_path_in_new_character_draft_root(sel_abs)
    try:
        logic.delete_new_character_draft_file(sel_abs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@app.post("/new_character/archive_base")
def new_character_archive_base(payload: NewCharacterRelPathPayload) -> dict[str, Any]:
    if not payload.relPath:
        raise HTTPException(status_code=400, detail="Missing relPath")
    sel_abs = resolve_storage_rel_file(payload.relPath)
    ensure_path_in_new_character_draft_root(sel_abs)
    try:
        archived_abs = logic.archive_new_character_draft_file(sel_abs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"archivedRelPath": storage_rel_from_abs(archived_abs)}


@app.get("/new_character/archive")
def new_character_archive_list() -> dict[str, Any]:
    paths = logic.list_character_archive_paths()
    return {
        "relPaths": [storage_rel_from_abs(p) for p in paths],
    }


@app.post("/new_character/import_from_archive")
def new_character_import_from_archive(payload: NewCharacterRelPathPayload) -> dict[str, Any]:
    if not payload.relPath:
        raise HTTPException(status_code=400, detail="Missing relPath")
    src_abs = resolve_storage_rel_file(payload.relPath)
    ensure_path_in_character_archive_root(src_abs)
    try:
        dest_abs = logic.import_character_archive_file_to_temp(src_abs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"previewRelPath": storage_rel_from_abs(dest_abs)}


@app.post("/new_character/append_upload")
def new_character_append_upload(
    file: UploadFile = File(...),
) -> dict[str, Any]:
    """Append upload as next ``baseN.*`` under ``characters/temp``."""
    import tempfile

    suffix = Path(file.filename or "").suffix or ".png"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(file.file.read())
        tmp.flush()
        tmp_path = Path(tmp.name)

    try:
        dest_abs = logic.append_uploaded_character_draft_to_temp(tmp_path)
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass

    return {
        "previewRelPath": storage_rel_from_abs(dest_abs),
    }


class GallerySplitItem(BaseModel):
    itemId: str
    folderKey: str
    relPath: str


class GallerySplitResponse(BaseModel):
    visible: list[GallerySplitItem]
    hidden: list[GallerySplitItem]


@app.get("/detail/{char_key}/pose_gallery_items_split", response_model=GallerySplitResponse)
def detail_pose_gallery_items_split(char_key: str) -> GallerySplitResponse:
    vis, hid = logic.list_pose_gallery_items_split(char_key)

    def _convert(items: list[tuple[str, str, str]]) -> list[GallerySplitItem]:
        out: list[GallerySplitItem] = []
        for item_id, folder_key, abs_p in items:
            if not abs_p:
                continue
            out.append(
                GallerySplitItem(
                    itemId=item_id,
                    folderKey=folder_key,
                    relPath=storage_rel_from_abs(abs_p),
                )
            )
        return out

    return GallerySplitResponse(visible=_convert(vis), hidden=_convert(hid))


@app.get("/detail/{char_key}/expression_gallery_items_split", response_model=GallerySplitResponse)
def detail_expression_gallery_items_split(char_key: str) -> GallerySplitResponse:
    vis, hid = logic.list_expression_gallery_items_split(char_key)

    def _convert(items: list[tuple[str, str, str]]) -> list[GallerySplitItem]:
        out: list[GallerySplitItem] = []
        for item_id, folder_key, abs_p in items:
            if not abs_p:
                continue
            out.append(
                GallerySplitItem(
                    itemId=item_id,
                    folderKey=folder_key,
                    relPath=storage_rel_from_abs(abs_p),
                )
            )
        return out

    return GallerySplitResponse(visible=_convert(vis), hidden=_convert(hid))


@app.get(
    "/detail/{char_key}/pose/gallery/{pose_key}",
    summary="Pose angle items for one logical gallery bucket; use pose_key=flat.",
)
def detail_pose_angle_gallery_items(char_key: str, pose_key: str) -> list[dict[str, str | int]]:
    items = logic.list_pose_angle_gallery_items(char_key, pose_key)
    out: list[dict[str, str | int]] = []
    for angle_id, abs_path in items:
        out.append(
            {
                "angleId": angle_id,
                "relPath": storage_rel_from_abs(abs_path),
            }
        )
    return out


@app.get(
    "/detail/{char_key}/expression/gallery/{expr_key}",
    summary="Expression angle items for one logical gallery bucket; use expr_key=flat.",
)
def detail_expression_angle_gallery_items(
    char_key: str, expr_key: str
) -> list[dict[str, str | int]]:
    items = logic.list_expression_angle_gallery_items(char_key, expr_key)
    out: list[dict[str, str | int]] = []
    for angle_id, abs_path in items:
        out.append(
            {
                "angleId": angle_id,
                "relPath": storage_rel_from_abs(abs_path),
            }
        )
    return out


@app.get("/detail/{char_key}/dataset/folder_names")
def detail_dataset_folder_names(char_key: str) -> list[str]:
    return logic.list_dataset_folder_names(char_key)


@app.get("/detail/{char_key}/dataset/images")
def detail_dataset_images(char_key: str, dataset_name: str) -> list[dict[str, str]]:
    paths = logic.list_dataset_image_paths(char_key, dataset_name)
    return [{"relPath": storage_rel_from_abs(p)} for p in paths]

