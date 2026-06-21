from __future__ import annotations

import logging
import os
import tempfile
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from services import logic

from .storage_paths import resolve_storage_rel_file

router = APIRouter(tags=["detail-sequence"])
logger = logging.getLogger(__name__)


@router.get("/detail/{char_key}/sequence/folder_names")
def sequence_folder_names(char_key: str) -> dict[str, list[str]]:
    return {"names": logic.list_sequence_folder_names(char_key)}


class SequenceFolderOrderBody(BaseModel):
    order: list[str]


@router.post("/detail/{char_key}/sequence/folder_order")
def sequence_folder_order(char_key: str, body: SequenceFolderOrderBody) -> dict[str, bool]:
    logic.set_sequence_folder_order(char_key, body.order)
    return {"ok": True}


class SequenceCreateEntry(BaseModel):
    sourceKind: str
    folderKey: str
    fileRelPath: str


class SequenceCreateBody(BaseModel):
    name: str
    entries: list[SequenceCreateEntry]


@router.post("/detail/{char_key}/sequence/create")
def sequence_create(char_key: str, body: SequenceCreateBody) -> dict[str, str]:
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(400, "Sequence name is required.")
    entries_out: list[dict[str, str]] = []
    for e in body.entries:
        if e.sourceKind not in ("pose", "expr"):
            raise HTTPException(400, f"Invalid source_kind: {e.sourceKind}")
        abs_path = str(resolve_storage_rel_file(e.fileRelPath))
        entries_out.append({"file_path": abs_path})
    # Empty entries are allowed: creates an empty sequence to drag images into.
    try:
        folder = logic.create_sequence_from_sources(char_key, name, entries_out)
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"folderName": folder.name, "message": f"Saved to sequence/{folder.name}/"}


@router.get("/detail/{char_key}/sequence/{sequence_name}")
def sequence_get(char_key: str, sequence_name: str) -> dict[str, Any]:
    try:
        return logic.read_sequence_manifest(char_key, sequence_name)
    except ValueError as ex:
        raise HTTPException(404, str(ex)) from ex


class SequencePutBody(BaseModel):
    manifest: dict[str, Any]


@router.put("/detail/{char_key}/sequence/{sequence_name}")
def sequence_put(char_key: str, sequence_name: str, body: SequencePutBody) -> dict[str, bool]:
    try:
        logic.write_sequence_manifest(char_key, sequence_name, body.manifest)
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"ok": True}


@router.post("/detail/{char_key}/sequence/{sequence_name}/repair_paths")
def sequence_repair_paths(char_key: str, sequence_name: str) -> dict[str, Any]:
    try:
        rewritten = logic.repair_sequence_manifest_rel_paths(char_key, sequence_name)
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"ok": True, "rewritten": int(rewritten)}


class SequenceDuplicateBody(BaseModel):
    sourceRelPath: str
    subfolder: str


class SequenceGenerateFlfBody(BaseModel):
    startIndex: int
    endIndex: int
    length: int = 33


class SequenceGenerateI2vBody(BaseModel):
    frameIndex: int
    length: int = 129
    width: int | None = None
    height: int | None = None
    positivePrompt: str | None = None


@router.post("/detail/{char_key}/sequence/{sequence_name}/generate_flf")
def sequence_generate_flf(
    char_key: str, sequence_name: str, body: SequenceGenerateFlfBody
) -> dict[str, Any]:
    def svc_log(line: str) -> None:
        logger.info("generate_flf[%s/%s] %s", char_key, sequence_name, line)

    try:
        return logic.generate_flf_sequence(
            char_key,
            sequence_name,
            start_index=int(body.startIndex),
            end_index=int(body.endIndex),
            length=max(1, int(body.length)),
            log_cb=svc_log,
        )
    except ValueError as ex:
        logger.warning(
            "generate_flf validation failed [%s/%s] indices=%s..%s length=%s: %s",
            char_key,
            sequence_name,
            body.startIndex,
            body.endIndex,
            body.length,
            ex,
        )
        raise HTTPException(
            status_code=400,
            detail={
                "error": str(ex),
                "stage": "generate_flf",
                "char_key": char_key,
                "sequence_name": sequence_name,
                "startIndex": body.startIndex,
                "endIndex": body.endIndex,
            },
        ) from ex
    except RuntimeError as ex:
        msg = str(ex)
        logger.error(
            "generate_flf failed [%s/%s] indices=%s..%s length=%s: %s",
            char_key,
            sequence_name,
            body.startIndex,
            body.endIndex,
            body.length,
            msg,
        )
        raise HTTPException(
            status_code=502,
            detail={"error": msg, "stage": "generate_flf"},
        ) from ex
    except Exception as ex:
        logger.exception(
            "generate_flf unexpected error [%s/%s] indices=%s..%s length=%s",
            char_key,
            sequence_name,
            body.startIndex,
            body.endIndex,
            body.length,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "error": f"{type(ex).__name__}: {ex}",
                "stage": "generate_flf",
            },
        ) from ex


@router.post("/detail/{char_key}/sequence/{sequence_name}/generate_i2v")
def sequence_generate_i2v(
    char_key: str, sequence_name: str, body: SequenceGenerateI2vBody
) -> dict[str, Any]:
    def svc_log(line: str) -> None:
        logger.info("generate_i2v[%s/%s] %s", char_key, sequence_name, line)

    try:
        return logic.generate_i2v_sequence(
            char_key,
            sequence_name,
            frame_index=int(body.frameIndex),
            length=max(1, int(body.length)),
            width=body.width,
            height=body.height,
            positive_prompt=(body.positivePrompt or "").strip() or None,
            log_cb=svc_log,
        )
    except ValueError as ex:
        logger.warning(
            "generate_i2v validation failed [%s/%s] frame=%s length=%s: %s",
            char_key,
            sequence_name,
            body.frameIndex,
            body.length,
            ex,
        )
        raise HTTPException(
            status_code=400,
            detail={
                "error": str(ex),
                "stage": "generate_i2v",
                "char_key": char_key,
                "sequence_name": sequence_name,
                "frameIndex": body.frameIndex,
            },
        ) from ex
    except RuntimeError as ex:
        msg = str(ex)
        logger.error(
            "generate_i2v failed [%s/%s] frame=%s length=%s: %s",
            char_key,
            sequence_name,
            body.frameIndex,
            body.length,
            msg,
        )
        raise HTTPException(
            status_code=502,
            detail={"error": msg, "stage": "generate_i2v"},
        ) from ex
    except Exception as ex:
        logger.exception(
            "generate_i2v unexpected error [%s/%s] frame=%s length=%s",
            char_key,
            sequence_name,
            body.frameIndex,
            body.length,
        )
        raise HTTPException(
            status_code=502,
            detail={
                "error": f"{type(ex).__name__}: {ex}",
                "stage": "generate_i2v",
            },
        ) from ex


class SequenceStripI2vBody(BaseModel):
    sourceRelPath: str
    outputDirRel: str
    length: int = 129
    width: int | None = None
    height: int | None = None
    positivePrompt: str


class SequenceStripFlfBody(BaseModel):
    imageRelPathA: str
    imageRelPathB: str
    outputDirRel: str
    length: int = 33


@router.post("/detail/{char_key}/sequence/{sequence_name}/strip_generate_i2v")
def sequence_strip_generate_i2v(
    char_key: str, sequence_name: str, body: SequenceStripI2vBody
) -> dict[str, Any]:
    def svc_log(line: str) -> None:
        logger.info("strip_i2v[%s/%s] %s", char_key, sequence_name, line)

    try:
        src_rel = body.sourceRelPath.strip()
        out_rel = body.outputDirRel.strip()
        prompt = (body.positivePrompt or "").strip()
        if not src_rel or not out_rel:
            raise ValueError("sourceRelPath and outputDirRel are required.")
        if not prompt:
            raise ValueError("positivePrompt is required.")
        logic._ensure_rel_under_sequence_folder(char_key, sequence_name, src_rel)
        logic._ensure_rel_under_sequence_folder(char_key, sequence_name, out_rel)
        src_abs = str(logic.resolve_storage_rel_path_to_abs(src_rel))
        out_abs = logic.resolve_storage_rel_path_to_abs(out_rel)
        if not out_abs.is_dir():
            raise ValueError("outputDirRel must be an existing directory.")
        rels = logic.generate_i2v_strip_segment(
            out_abs,
            src_abs,
            length=max(1, int(body.length)),
            prompt=prompt,
            width=body.width,
            height=body.height,
            log_cb=svc_log,
        )
        return {"relPaths": rels}
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    except RuntimeError as ex:
        raise HTTPException(502, detail={"error": str(ex), "stage": "strip_generate_i2v"}) from ex


@router.post("/detail/{char_key}/sequence/{sequence_name}/strip_generate_flf")
def sequence_strip_generate_flf(
    char_key: str, sequence_name: str, body: SequenceStripFlfBody
) -> dict[str, Any]:
    def svc_log(line: str) -> None:
        logger.info("strip_flf[%s/%s] %s", char_key, sequence_name, line)

    try:
        rel_a = body.imageRelPathA.strip()
        rel_b = body.imageRelPathB.strip()
        out_rel = body.outputDirRel.strip()
        if not rel_a or not rel_b or not out_rel:
            raise ValueError("imageRelPathA, imageRelPathB, and outputDirRel are required.")
        logic._ensure_rel_under_sequence_folder(char_key, sequence_name, rel_a)
        logic._ensure_rel_under_sequence_folder(char_key, sequence_name, rel_b)
        logic._ensure_rel_under_sequence_folder(char_key, sequence_name, out_rel)
        abs_a = str(logic.resolve_storage_rel_path_to_abs(rel_a))
        abs_b = str(logic.resolve_storage_rel_path_to_abs(rel_b))
        out_abs = logic.resolve_storage_rel_path_to_abs(out_rel)
        if not out_abs.is_dir():
            raise ValueError("outputDirRel must be an existing directory.")
        rels = logic.generate_flf_strip_segment(
            out_abs,
            abs_a,
            abs_b,
            length=max(1, int(body.length)),
            log_cb=svc_log,
        )
        return {"relPaths": rels}
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    except RuntimeError as ex:
        raise HTTPException(502, detail={"error": str(ex), "stage": "strip_generate_flf"}) from ex


@router.get("/detail/{char_key}/sequence/{sequence_name}/export_timeline_mp4")
def sequence_export_timeline_mp4(char_key: str, sequence_name: str) -> FileResponse:
    """Slideshow: one frame per visible timeline cell at ``manifest.fps``."""
    name = sequence_name.strip()
    if not name:
        raise HTTPException(400, "Sequence name is required.")
    tmp = tempfile.NamedTemporaryFile(delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        result = logic.write_sequence_timeline_slideshow_mp4(char_key, name, tmp_path)
    except ValueError as ex:
        if os.path.isfile(tmp_path):
            os.unlink(tmp_path)
        logger.warning(
            "export_timeline_mp4 validation failed [%s/%s]: %s", char_key, name, ex
        )
        raise HTTPException(400, str(ex)) from ex
    except RuntimeError as ex:
        if os.path.isfile(tmp_path):
            os.unlink(tmp_path)
        logger.error("export_timeline_mp4 failed [%s/%s]: %s", char_key, name, ex)
        raise HTTPException(
            502, detail={"error": str(ex), "stage": "export_timeline_mp4"}
        ) from ex
    except Exception as ex:
        if os.path.isfile(tmp_path):
            os.unlink(tmp_path)
        logger.exception("export_timeline_mp4 unexpected [%s/%s]", char_key, name)
        raise HTTPException(
            502,
            detail={
                "error": f"{type(ex).__name__}: {ex}",
                "stage": "export_timeline_mp4",
            },
        ) from ex

    safe = logic.sanitize_for_folder(name)
    filename = f"{safe}_timeline.{result['ext']}"
    out_path = result["absPath"]

    def _unlink(path: str) -> None:
        try:
            os.unlink(path)
        except OSError:
            pass

    return FileResponse(
        out_path,
        media_type=result["mediaType"],
        filename=filename,
        background=BackgroundTask(_unlink, out_path),
    )


@router.get("/detail/{char_key}/sequence/{sequence_name}/export_gallery_frame_set_mp4")
def sequence_export_gallery_frame_set_mp4(
    char_key: str,
    sequence_name: str,
    gallery_id: str = Query(..., min_length=1),
) -> FileResponse:
    """Linear video for one gallery item's frame sequence strip (24 fps)."""
    name = sequence_name.strip()
    if not name:
        raise HTTPException(400, "Sequence name is required.")
    gid = (gallery_id or "").strip()
    if not gid:
        raise HTTPException(400, "gallery_id is required.")
    tmp = tempfile.NamedTemporaryFile(delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        result = logic.write_gallery_frame_sequence_set_mp4(char_key, name, gid, tmp_path)
    except ValueError as ex:
        if os.path.isfile(tmp_path):
            os.unlink(tmp_path)
        logger.warning(
            "export_gallery_frame_set_mp4 validation failed [%s/%s]: %s",
            char_key,
            name,
            ex,
        )
        raise HTTPException(400, str(ex)) from ex
    except RuntimeError as ex:
        if os.path.isfile(tmp_path):
            os.unlink(tmp_path)
        logger.error("export_gallery_frame_set_mp4 failed [%s/%s]: %s", char_key, name, ex)
        raise HTTPException(
            502, detail={"error": str(ex), "stage": "export_gallery_frame_set_mp4"}
        ) from ex
    except Exception as ex:
        if os.path.isfile(tmp_path):
            os.unlink(tmp_path)
        logger.exception("export_gallery_frame_set_mp4 unexpected [%s/%s]", char_key, name)
        raise HTTPException(
            502,
            detail={
                "error": f"{type(ex).__name__}: {ex}",
                "stage": "export_gallery_frame_set_mp4",
            },
        ) from ex

    safe = logic.sanitize_for_folder(name)
    safe_gid = logic.sanitize_for_folder(gid) or "set"
    filename = f"{safe}_{safe_gid}_set.{result['ext']}"
    out_path = result["absPath"]

    def _unlink(path: str) -> None:
        try:
            os.unlink(path)
        except OSError:
            pass

    return FileResponse(
        out_path,
        media_type=result["mediaType"],
        filename=filename,
        background=BackgroundTask(_unlink, out_path),
    )


@router.post("/detail/{char_key}/sequence/{sequence_name}/duplicate_asset")
def sequence_duplicate_asset(
    char_key: str, sequence_name: str, body: SequenceDuplicateBody
) -> dict[str, str]:
    rel = (body.sourceRelPath or "").strip()
    sub = (body.subfolder or "").strip()
    if sub not in ("gallery", "cells"):
        raise HTTPException(400, "subfolder must be gallery or cells")
    try:
        src = resolve_storage_rel_file(rel)
    except HTTPException:
        raise
    except Exception as ex:
        raise HTTPException(400, str(ex)) from ex
    try:
        new_rel = logic.duplicate_sequence_asset(
            char_key, sequence_name, str(src), subfolder=sub
        )
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"relPath": new_rel}


class SequenceRenameFolderBody(BaseModel):
    oldName: str
    newLabel: str


@router.post("/detail/{char_key}/sequence/folder/rename")
def sequence_folder_rename(char_key: str, body: SequenceRenameFolderBody) -> dict[str, str]:
    try:
        new_key = logic.rename_sequence_folder(
            char_key, body.oldName.strip(), body.newLabel.strip()
        )
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"newName": new_key}


class SequenceDuplicateFolderBody(BaseModel):
    sourceName: str
    newLabel: str


@router.post("/detail/{char_key}/sequence/folder/duplicate")
def sequence_folder_duplicate(
    char_key: str, body: SequenceDuplicateFolderBody
) -> dict[str, str]:
    try:
        new_key = logic.duplicate_sequence_folder(
            char_key, body.sourceName.strip(), body.newLabel.strip()
        )
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"newName": new_key}


class SequenceDeleteFolderBody(BaseModel):
    name: str


@router.post("/detail/{char_key}/sequence/folder/delete")
def sequence_folder_delete(char_key: str, body: SequenceDeleteFolderBody) -> dict[str, bool]:
    try:
        logic.delete_sequence_folder(char_key, body.name.strip())
    except ValueError as ex:
        raise HTTPException(400, str(ex)) from ex
    return {"ok": True}
