from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from services import logic

from .preview_storage import persist_preview_from_abs
from .storage_paths import resolve_storage_rel_file, storage_rel_from_abs
from .ws_streaming import run_with_log_stream, safe_send_json

router = APIRouter(tags=["detail-dataset"])
# Preview files: remove_background writes OS temp then ``persist_preview_from_abs`` copies into
# ``<character>/.react_previews/`` so ``/assets/storage/...`` can serve them. Staging uploads use
# ``<character>/.react_staging/``. Both dirs stay under the character folder for containment.


class BuilderSourceItem(BaseModel):
    tileId: str
    sourceKind: str
    folderKey: str
    relPath: str
    hidden: bool = False


@router.get("/detail/{char_key}/dataset/builder_sources")
def dataset_builder_sources(char_key: str) -> dict[str, Any]:
    logic.list_pose_gallery_items_split(char_key)
    logic.list_expression_gallery_items_split(char_key)
    st = logic.read_gallery_ui_state(char_key)
    pose_map = logic.all_pose_flat_gallery_item_ids(char_key)
    expr_map = logic.all_expression_flat_gallery_item_ids(char_key)
    hid_p = set(st.get(logic.HIDDEN_POSE_IMAGES) or [])
    hid_e = set(st.get(logic.HIDDEN_EXPR_IMAGES) or [])

    all_items: list[BuilderSourceItem] = []
    for iid in st.get(logic.POSE_IMAGE_ORDER) or []:
        if iid not in pose_map:
            continue
        fk, rel = pose_map[iid]
        all_items.append(
            BuilderSourceItem(
                tileId=iid,
                sourceKind="pose",
                folderKey=fk,
                relPath=rel,
                hidden=iid in hid_p,
            )
        )
    for iid in st.get(logic.EXPR_IMAGE_ORDER) or []:
        if iid not in expr_map:
            continue
        fk, rel = expr_map[iid]
        all_items.append(
            BuilderSourceItem(
                tileId=iid,
                sourceKind="expr",
                folderKey=fk,
                relPath=rel,
                hidden=iid in hid_e,
            )
        )

    by_id: dict[str, BuilderSourceItem] = {it.tileId: it for it in all_items}
    ordered_ids = logic.apply_dataset_builder_order(char_key, list(by_id.keys()))
    ordered = [by_id[tid] for tid in ordered_ids if tid in by_id]
    poses = [it for it in ordered if it.sourceKind == "pose"]
    exprs = [it for it in ordered if it.sourceKind == "expr"]
    st = logic.read_gallery_ui_state(char_key)
    pose_strip, expr_strip = logic.resolve_dataset_builder_strips(ordered, st)
    return {
        "poses": poses,
        "expressions": exprs,
        "items": ordered,
        "poseStripIds": pose_strip,
        "exprStripIds": expr_strip,
    }


class DatasetBuilderOrderBody(BaseModel):
    tileIds: list[str]
    poseStripIds: list[str] | None = None
    exprStripIds: list[str] | None = None


@router.post("/detail/{char_key}/dataset/builder_order")
def dataset_builder_order(char_key: str, body: DatasetBuilderOrderBody) -> dict[str, bool]:
    logic.set_dataset_builder_order(
        char_key,
        body.tileIds,
        body.poseStripIds,
        body.exprStripIds,
    )
    return {"ok": True}


class DatasetSavedOrderBody(BaseModel):
    basenames: list[str]


@router.post("/detail/{char_key}/dataset/{dataset_name}/order")
def dataset_saved_order(
    char_key: str, dataset_name: str, body: DatasetSavedOrderBody
) -> dict[str, bool]:
    logic.set_dataset_saved_order(char_key, dataset_name, body.basenames)
    return {"ok": True}


class DatasetExportEntry(BaseModel):
    sourceKind: str
    folderKey: str
    fileRelPath: str


class DatasetExportBody(BaseModel):
    name: str
    entries: list[DatasetExportEntry]


@router.post("/detail/{char_key}/dataset/export")
def dataset_export(char_key: str, body: DatasetExportBody) -> dict[str, str]:
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Dataset name is required.")
    entries_out: list[dict[str, Any]] = []
    for e in body.entries:
        if e.sourceKind not in ("pose", "expr"):
            raise HTTPException(400, f"Invalid source_kind: {e.sourceKind}")
        abs_path = str(resolve_storage_rel_file(e.fileRelPath))
        entries_out.append(
            {
                "source_kind": e.sourceKind,
                "folder_key": e.folderKey,
                "file_path": abs_path,
            }
        )
    if not entries_out:
        raise HTTPException(400, "No images to export.")
    try:
        folder = logic.write_dataset_export(char_key, name, entries_out)
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"folderName": folder.name, "message": f"Saved to dataset/{folder.name}/"}


class DatasetRenameFolderBody(BaseModel):
    oldName: str
    newLabel: str


@router.post("/detail/{char_key}/dataset/folder/rename")
def dataset_folder_rename(char_key: str, body: DatasetRenameFolderBody) -> dict[str, str]:
    try:
        new_key = logic.rename_dataset_folder(
            char_key, body.oldName.strip(), body.newLabel.strip()
        )
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"newName": new_key}


class DatasetDuplicateFolderBody(BaseModel):
    sourceName: str
    newLabel: str


@router.post("/detail/{char_key}/dataset/folder/duplicate")
def dataset_folder_duplicate(
    char_key: str, body: DatasetDuplicateFolderBody
) -> dict[str, str]:
    try:
        new_key = logic.duplicate_dataset_folder(
            char_key, body.sourceName.strip(), body.newLabel.strip()
        )
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"newName": new_key}


@router.get("/detail/{char_key}/dataset/{dataset_name}/download_zip")
def dataset_folder_download_zip(char_key: str, dataset_name: str) -> FileResponse:
    try:
        zip_abs, filename = logic.write_dataset_folder_zip_file(char_key, dataset_name)
    except ValueError as ex:
        msg = str(ex)
        if msg == "Dataset folder not found.":
            raise HTTPException(status_code=404, detail=msg) from ex
        raise HTTPException(status_code=400, detail=msg) from ex

    def _unlink(path: str) -> None:
        try:
            os.unlink(path)
        except OSError:
            pass

    return FileResponse(
        zip_abs,
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(_unlink, zip_abs),
    )


class DatasetDeleteFolderBody(BaseModel):
    name: str


@router.post("/detail/{char_key}/dataset/folder/delete")
def dataset_folder_delete(char_key: str, body: DatasetDeleteFolderBody) -> dict[str, bool]:
    try:
        logic.delete_dataset_folder(char_key, body.name.strip())
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"ok": True}


class DatasetRenameImageBody(BaseModel):
    datasetName: str
    oldBasename: str
    newLabel: str


@router.post("/detail/{char_key}/dataset/image/rename")
def dataset_image_rename(char_key: str, body: DatasetRenameImageBody) -> dict[str, str]:
    try:
        new_bn = logic.rename_dataset_export_image(
            char_key,
            body.datasetName.strip(),
            body.oldBasename.strip(),
            body.newLabel.strip(),
        )
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"newBasename": new_bn}


class DatasetPreviewNoiseBody(BaseModel):
    sourceRelPath: str


@router.post("/detail/{char_key}/dataset/preview/add_noise")
def dataset_preview_add_noise(
    char_key: str, body: DatasetPreviewNoiseBody
) -> dict[str, str]:
    """Composite source onto Gaussian noise; result stored under ``.react_previews/``."""
    src = str(resolve_storage_rel_file(body.sourceRelPath))
    try:
        temp_path = logic.composite_image_on_gaussian_noise_to_temp(src)
        rel = persist_preview_from_abs(temp_path, char_key)
    except Exception as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"previewRelPath": rel}


class DatasetSavedCommitEntry(BaseModel):
    basename: str
    removed: bool = False
    """When not removed, copy this file over ``basename`` in the dataset folder."""
    displayRelPath: str | None = None


class DatasetSavedCommitBody(BaseModel):
    datasetName: str
    entries: list[DatasetSavedCommitEntry]


@router.post("/detail/{char_key}/dataset/saved/commit")
def dataset_saved_commit(char_key: str, body: DatasetSavedCommitBody) -> dict[str, str]:
    """
    Mirror PyQt saved-view Save: delete removed files, copy display paths into the folder,
    rewrite a simple manifest.
    """
    import shutil

    name = body.datasetName.strip()
    folder = logic.dataset_folder_path(char_key, name)
    if not folder.is_dir():
        raise HTTPException(404, "Dataset folder not found.")
    manifest = logic.DATASET_MANIFEST_NAME
    try:
        for e in body.entries:
            safe_bn = Path(e.basename).name
            if safe_bn == manifest or not safe_bn:
                continue
            target = folder / safe_bn
            if e.removed:
                if target.is_file():
                    target.unlink()
                continue
            if not e.displayRelPath:
                raise HTTPException(400, f"Missing displayRelPath for {safe_bn}")
            src = resolve_storage_rel_file(e.displayRelPath)
            if src.resolve() != target.resolve():
                shutil.copy2(src, target)
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(400, str(ex)) from ex

    remaining = sorted(
        p.name
        for p in folder.iterdir()
        if p.is_file()
        and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}
        and p.name != manifest
    )
    with open(folder / manifest, "w", encoding="utf-8") as f:
        json.dump(
            {
                "version": 1,
                "items": [{"index": i, "filename": n} for i, n in enumerate(remaining)],
            },
            f,
            indent=2,
        )
    return {"ok": True, "message": "Dataset folder updated."}


@router.websocket("/detail/{char_key}/dataset/ws")
async def dataset_job_ws(ws: WebSocket, char_key: str) -> None:
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return

    job = (msg.get("job") or "").strip()
    try:
        if job == "remove_background":
            rel = (msg.get("sourceRelPath") or "").strip()
            if not rel:
                raise ValueError("sourceRelPath required")
            src_abs = str(resolve_storage_rel_file(rel))

            def work(log_cb):
                temp_path = logic.remove_background_to_temp_file(src_abs, log_cb=log_cb)
                preview_rel = persist_preview_from_abs(temp_path, char_key)
                return {"previewRelPath": preview_rel}

            result, err = await run_with_log_stream(ws, work)
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(
                    ws, {"type": "done", "ok": True, "result": result}
                )
        elif job == "ai_edit_builder_preview":
            rel = (msg.get("sourceRelPath") or "").strip()
            prompt_text = (msg.get("promptText") or "").strip()
            source_kind = (msg.get("sourceKind") or "").strip().lower()
            if not rel:
                raise ValueError("sourceRelPath required")
            if not prompt_text:
                raise ValueError("promptText required")
            src_abs = str(resolve_storage_rel_file(rel))
            mask_abs_path = logic.decode_mask_png_to_temp_file(
                msg.get("maskPngBase64")
            )

            def _abs_under(path: Path, root: Path) -> bool:
                try:
                    path.resolve().relative_to(root.resolve())
                    return True
                except ValueError:
                    return False

            def work(log_cb):
                temp_path = logic.ai_edit_image_inline_to_temp_file(
                    input_image_abs_path=src_abs,
                    prompt_text=prompt_text,
                    mask_abs_path=mask_abs_path,
                    log_cb=log_cb,
                )
                try:
                    character = logic.get_character_paths(char_key)
                    src_p = Path(src_abs).resolve()
                    tmp_p = Path(temp_path).resolve()
                    pose_root = character.poses_dir.resolve()
                    expr_root = character.expressions_dir.resolve()

                    if source_kind == "pose":
                        use_pose = True
                    elif source_kind == "expr":
                        use_pose = False
                    elif _abs_under(src_p, pose_root):
                        use_pose = True
                    elif _abs_under(src_p, expr_root):
                        use_pose = False
                    else:
                        raise ValueError(
                            "AI edit builder: source must be under poses/ or expressions/, "
                            "or pass sourceKind pose|expr"
                        )

                    if use_pose:
                        dest_dir = character.poses_dir
                        if not _abs_under(src_p, pose_root):
                            raise ValueError(
                                "AI edit builder: source file is not under poses/ for a pose tile"
                            )
                    else:
                        dest_dir = character.expressions_dir
                        if not _abs_under(src_p, expr_root):
                            raise ValueError(
                                "AI edit builder: source file is not under expressions/ "
                                "for an expression tile"
                            )

                    stem = src_p.stem
                    edited_index = logic._next_edit_suffix_index(dest_dir, stem)
                    ext = tmp_p.suffix or src_p.suffix or ".png"
                    dest = dest_dir / f"{stem}_edit_{edited_index:03d}{ext}"
                    shutil.copy2(tmp_p, dest)
                    if use_pose:
                        gallery_rel = logic._append_pose_gallery_file_to_order(
                            char_key, dest
                        )
                    else:
                        gallery_rel = logic._append_expr_gallery_file_to_order(
                            char_key, dest
                        )
                finally:
                    Path(temp_path).unlink(missing_ok=True)
                    if mask_abs_path:
                        Path(mask_abs_path).unlink(missing_ok=True)
                return {"previewRelPath": gallery_rel}

            result, err = await run_with_log_stream(ws, work)
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(ws, {"type": "done", "ok": True, "result": result})

        elif job == "ai_edit_saved_dataset_image":
            dataset_name = (msg.get("datasetName") or "").strip()
            rel = (msg.get("sourceRelPath") or "").strip()
            prompt_text = (msg.get("promptText") or "").strip()
            if not dataset_name:
                raise ValueError("datasetName required")
            if not rel:
                raise ValueError("sourceRelPath required")
            if not prompt_text:
                raise ValueError("promptText required")
            src_abs = str(resolve_storage_rel_file(rel))
            mask_abs_path = logic.decode_mask_png_to_temp_file(
                msg.get("maskPngBase64")
            )

            def work(log_cb):
                try:
                    new_abs = logic.ai_edit_image_inline_to_dataset_file(
                        char_key=char_key,
                        dataset_name=dataset_name,
                        source_image_abs_path=src_abs,
                        prompt_text=prompt_text,
                        mask_abs_path=mask_abs_path,
                        log_cb=log_cb,
                    )
                finally:
                    if mask_abs_path:
                        Path(mask_abs_path).unlink(missing_ok=True)
                return {"fileRelPath": storage_rel_from_abs(new_abs)}

            result, err = await run_with_log_stream(ws, work)
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
        elif job == "ai_edit_sequence_gallery_image":
            sequence_name = (msg.get("sequenceName") or "").strip()
            rel = (msg.get("sourceRelPath") or "").strip()
            prompt_text = (msg.get("promptText") or "").strip()
            if not sequence_name:
                raise ValueError("sequenceName required")
            if not rel:
                raise ValueError("sourceRelPath required")
            if not prompt_text:
                raise ValueError("promptText required")
            src_abs = str(resolve_storage_rel_file(rel))
            mask_abs_path = logic.decode_mask_png_to_temp_file(
                msg.get("maskPngBase64")
            )

            def work(log_cb):
                try:
                    new_abs = logic.ai_edit_sequence_gallery_image(
                        char_key=char_key,
                        sequence_name=sequence_name,
                        source_image_abs_path=src_abs,
                        prompt_text=prompt_text,
                        mask_abs_path=mask_abs_path,
                        log_cb=log_cb,
                    )
                finally:
                    if mask_abs_path:
                        Path(mask_abs_path).unlink(missing_ok=True)
                return {"fileRelPath": storage_rel_from_abs(new_abs)}

            result, err = await run_with_log_stream(ws, work)
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
        else:
            await safe_send_json(
                ws, {"type": "done", "ok": False, "error": f"Unknown job: {job!r}"}
            )
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})
