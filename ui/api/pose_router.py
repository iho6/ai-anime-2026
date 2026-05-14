from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from services import logic

from .preview_storage import save_staging_upload
from .storage_paths import resolve_storage_rel_file, storage_rel_from_abs
from .ws_streaming import run_with_log_stream, safe_send_json

logger = logging.getLogger(__name__)

router = APIRouter(tags=["detail-pose"])


class PoseCatalogItem(BaseModel):
    id: int
    label: str
    promptText: str


@router.get("/detail/{char_key}/pose/catalog", response_model=list[PoseCatalogItem])
def pose_catalog(char_key: str) -> list[PoseCatalogItem]:
    if not char_key:
        raise HTTPException(400, "Missing char_key")
    out: list[PoseCatalogItem] = []
    for pid, opt in sorted(logic.POSE_BY_ID.items()):
        out.append(
            PoseCatalogItem(id=pid, label=opt.label, promptText=opt.prompt_text)
        )
    return out


@router.get("/detail/{char_key}/pose/angle_groups")
def pose_angle_groups(char_key: str) -> list[dict[str, Any]]:
    if not char_key:
        raise HTTPException(400, "Missing char_key")
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


class PoseHiddenBody(BaseModel):
    itemIds: list[str]
    hidden: bool


@router.post("/detail/{char_key}/pose/gallery/hidden")
def pose_gallery_hidden(char_key: str, body: PoseHiddenBody) -> dict[str, bool]:
    logic.set_pose_gallery_hidden(char_key, body.itemIds, body.hidden)
    return {"ok": True}


class PoseUiStateBody(BaseModel):
    order: list[str]
    hiddenKeys: list[str]


@router.post("/detail/{char_key}/pose/gallery/ui_state")
def pose_gallery_ui_state(char_key: str, body: PoseUiStateBody) -> dict[str, bool]:
    logic.set_pose_gallery_ui_state(char_key, body.order, body.hiddenKeys)
    return {"ok": True}


class PoseRenameBody(BaseModel):
    oldKey: str
    newLabel: str


@router.post("/detail/{char_key}/pose/folder/rename")
def pose_folder_rename(char_key: str, body: PoseRenameBody) -> dict[str, str]:
    new_key = logic.rename_pose_folder(char_key, body.oldKey, body.newLabel.strip())
    return {"newKey": new_key}


class PoseDeleteBody(BaseModel):
    poseKey: str


@router.post("/detail/{char_key}/pose/folder/delete")
def pose_folder_delete(char_key: str, body: PoseDeleteBody) -> dict[str, bool]:
    logic.delete_pose_folder(char_key, body.poseKey)
    return {"ok": True}


class PoseAngleDeleteBody(BaseModel):
    poseKey: str
    relPaths: list[str]


@router.post("/detail/{char_key}/pose/angles/delete")
def pose_angles_delete(char_key: str, body: PoseAngleDeleteBody) -> dict[str, int]:
    deleted = logic.delete_pose_angle_images(char_key, body.poseKey, body.relPaths)
    return {"deleted": int(deleted)}


class PoseAngleOrderBody(BaseModel):
    filenames: list[str]


@router.post("/detail/{char_key}/pose/{pose_key}/angles/order")
def pose_angles_order(char_key: str, pose_key: str, body: PoseAngleOrderBody) -> dict[str, bool]:
    logic.set_pose_angle_order(char_key, pose_key, body.filenames)
    return {"ok": True}


@router.post("/detail/{char_key}/pose/ensure_base")
def pose_ensure_base(char_key: str) -> dict[str, str | None]:
    rel = logic.ensure_base_pose_in_gallery(char_key)
    return {
        "relPath": rel,
        "poseKey": logic.POSE_FLAT_BUCKET,
    }


@router.post("/detail/{char_key}/pose/import_starting")
async def pose_import_starting(
    char_key: str,
    file: UploadFile = File(...),
    pose_folder_name: str = Form(""),
) -> dict[str, str]:
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    import tempfile
    from pathlib import Path

    suffix = Path(file.filename or "").suffix or ".png"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp.flush()
        tmp_path = Path(tmp.name)
    try:
        name = (pose_folder_name or "").strip() or Path(file.filename or "import").stem
        rel = logic.import_external_pose_starting_image(char_key, name, tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)
    return {"relPath": rel, "poseKey": logic.POSE_FLAT_BUCKET}


class PoseImportStartingFromRelBody(BaseModel):
    sourceRelPath: str
    pose_folder_name: str = ""


@router.post("/detail/{char_key}/pose/import_starting_from_rel")
def pose_import_starting_from_rel(
    char_key: str, body: PoseImportStartingFromRelBody
) -> dict[str, str]:
    """Copy a pose/expression gallery file into ``poses/`` without multipart upload."""
    if not char_key.strip():
        raise HTTPException(400, "Missing char_key")
    src = (body.sourceRelPath or "").strip()
    if not src:
        raise HTTPException(400, "sourceRelPath required")
    try:
        rel = logic.import_pose_starting_from_gallery_rel_path(
            char_key,
            src,
            pose_folder_name=(body.pose_folder_name or "").strip() or None,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"relPath": rel, "poseKey": logic.POSE_FLAT_BUCKET}


@router.post("/detail/{char_key}/pose/import_multi_angle")
async def pose_import_multi_angle(
    char_key: str,
    pose_key: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, str]:
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    rel = save_staging_upload(char_key, data, file.filename or "angle.png")
    abs_path = str(resolve_storage_rel_file(rel))
    logic.import_manual_multi_angle_image_for_pose(char_key, pose_key, abs_path)
    return {"ok": True, "stagingRelPath": rel}


@router.post("/detail/{char_key}/upload_staging")
async def upload_staging(char_key: str, file: UploadFile = File(...)) -> dict[str, str]:
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    rel = save_staging_upload(char_key, data, file.filename or "upload.png")
    return {"relPath": rel}


@router.websocket("/detail/{char_key}/pose/ws")
async def pose_job_ws(ws: WebSocket, char_key: str) -> None:
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return

    job = (msg.get("job") or "").strip()

    def base_abs_from_msg() -> str:
        rel = (msg.get("baseRelPath") or "").strip()
        if rel:
            return str(resolve_storage_rel_file(rel))
        bp = logic.character_base_image_path(char_key)
        if not bp:
            raise ValueError("Base image is missing; create/save a character first.")
        return str(bp)

    def keypoint_abs_from_msg() -> str | None:
        rel = (msg.get("keypointRelPath") or "").strip()
        if not rel:
            return None
        p = resolve_storage_rel_file(rel)
        if not p.is_file():
            raise ValueError(f"Keypoint image not found: {rel}")
        return str(p)

    try:
        if job == "generate_prompts":
            prompts = msg.get("prompts") or []
            if not isinstance(prompts, list):
                raise ValueError("prompts must be a list")
            texts = [str(p).strip() for p in prompts if str(p).strip()]
            input_abs = base_abs_from_msg()
            keypoint_abs = keypoint_abs_from_msg()
            if not texts and not keypoint_abs:
                raise ValueError("No prompts provided.")

            def work(log_cb):
                rows = logic.generate_pose_starting_images_from_prompts(
                    char_key,
                    input_abs,
                    texts,
                    log_cb=log_cb,
                    keypoint_image_path=keypoint_abs,
                )
                last_abs = rows[-1][0] if rows else input_abs
                rels = [r[1] for r in rows]
                return {
                    "relPaths": rels,
                    "poseKeys": [logic.POSE_FLAT_BUCKET] * len(rels),
                    "lastInputRelPath": storage_rel_from_abs(last_abs),
                    "firstPoseRelPath": rows[0][1] if rows else None,
                    "firstPoseKey": logic.POSE_FLAT_BUCKET,
                }

            result, err = await run_with_log_stream(ws, work)
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(
                    ws, {"type": "done", "ok": True, "result": result}
                )

        elif job == "generate_catalog":
            items = msg.get("items") or []
            if not isinstance(items, list) or not items:
                raise ValueError("items required")
            input_abs = base_abs_from_msg()
            keypoint_abs = keypoint_abs_from_msg()

            def work2(log_cb):
                results: list[dict[str, Any]] = []
                last_path = input_abs
                for it in items:
                    pid = int(it.get("catalogId"))
                    if pid not in logic.POSE_BY_ID:
                        raise ValueError(f"Unknown pose id: {pid}")
                    label = str(it.get("label") or "").strip()
                    if not label:
                        label = logic.POSE_BY_ID[pid].label
                    prompt_override = logic.build_pose_prompt_from_label(label)
                    out_path, rel = logic.generate_pose_starting_image_from_prompt(
                        char_key,
                        pid,
                        input_abs,
                        prompt_override,
                        log_cb=log_cb,
                        keypoint_image_path=keypoint_abs,
                    )
                    last_path = out_path
                    results.append(
                        {
                            "poseKey": logic.POSE_FLAT_BUCKET,
                            "relPath": rel,
                            "path": out_path,
                        }
                    )
                return {
                    "rows": results,
                    "lastInputRelPath": storage_rel_from_abs(last_path),
                    "firstPoseKey": logic.POSE_FLAT_BUCKET,
                    "firstPoseRelPath": results[0]["relPath"] if results else None,
                }

            result, err = await run_with_log_stream(ws, work2)
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(
                    ws, {"type": "done", "ok": True, "result": result}
                )

        elif job == "angles":
            pose_keys = msg.get("poseKeys") or []
            if not isinstance(pose_keys, list):
                pose_keys = []
            if not pose_keys:
                pose_keys = [logic.POSE_FLAT_BUCKET]
            angle_ids = [int(x) for x in (msg.get("angleIds") or [])]
            input_abs_list: list[str] = []
            raw_multi = msg.get("inputRelPaths")
            if isinstance(raw_multi, list) and raw_multi:
                for r in raw_multi:
                    s = str(r).strip()
                    if s:
                        input_abs_list.append(str(resolve_storage_rel_file(s)))
            else:
                input_rel = (msg.get("inputRelPath") or "").strip()
                if input_rel:
                    input_abs_list.append(str(resolve_storage_rel_file(input_rel)))

            def work3(log_cb):
                logger.info(
                    "pose ws angles: char=%s keys=%s angle_ids=%s input_paths=%d",
                    char_key,
                    pose_keys,
                    angle_ids,
                    len(input_abs_list),
                )
                for pk in pose_keys:
                    logic.run_pose_multi_angle_ws_job(
                        char_key,
                        pk,
                        angle_ids,
                        input_abs_list,
                        log_cb=log_cb,
                    )
                return {"ok": True}

            result, err = await run_with_log_stream(ws, work3)
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(
                    ws, {"type": "done", "ok": True, "result": result}
                )
        elif job == "ai_edit_pose":
            pose_key = (msg.get("poseKey") or "").strip() or logic.POSE_FLAT_BUCKET
            source_rel_path = (msg.get("sourceRelPath") or "").strip()
            prompt_text = (msg.get("promptText") or "").strip()
            if not source_rel_path:
                raise ValueError("sourceRelPath required")
            if not prompt_text:
                raise ValueError("promptText required")

            source_abs_path = str(resolve_storage_rel_file(source_rel_path))

            def work(log_cb):
                new_abs = logic.ai_edit_pose_in_bucket(
                    char_key,
                    pose_key=pose_key,
                    source_image_abs_path=source_abs_path,
                    prompt_text=prompt_text,
                    log_cb=log_cb,
                )
                return {"newRelPath": storage_rel_from_abs(new_abs)}

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


# --- Pose reference / keypoint ------------------------------------------------


@router.websocket("/detail/{char_key}/pose/keypoint_ws")
async def pose_keypoint_ws(ws: WebSocket, char_key: str) -> None:
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return

    job = (msg.get("job") or "").strip()
    try:
        if job != "run_keypoint":
            raise ValueError(f"Unknown job: {job!r}")

        input_rel = (msg.get("inputRelPath") or "").strip()
        if not input_rel:
            raise ValueError("inputRelPath required")
        input_abs = str(resolve_storage_rel_file(input_rel))

        def work(log_cb):
            kp_abs = logic.run_pose_keypoint_for_image(input_abs, log_cb=log_cb)
            ref_entry = logic.save_pose_reference(char_key, input_abs, kp_abs)
            return {
                "refId": ref_entry["id"],
                "referenceRelPath": ref_entry["referenceRelPath"],
                "keypointRelPath": ref_entry["keypointRelPath"],
            }

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.get("/detail/{char_key}/pose/references")
def pose_references(char_key: str) -> list[dict[str, Any]]:
    if not char_key:
        raise HTTPException(400, "Missing char_key")
    return logic.list_pose_references(char_key)


@router.delete("/detail/{char_key}/pose/reference/{ref_id}")
def pose_reference_delete(char_key: str, ref_id: str) -> dict[str, bool]:
    if not char_key or not ref_id:
        raise HTTPException(400, "Missing char_key or ref_id")
    found = logic.delete_pose_reference(char_key, ref_id)
    if not found:
        raise HTTPException(404, "Reference not found")
    return {"ok": True}


@router.post("/detail/{char_key}/pose/upload_reference")
async def pose_upload_reference(
    char_key: str,
    file: UploadFile = File(...),
) -> dict[str, str]:
    """Upload a reference image to staging and return its storage-relative path."""
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    rel = save_staging_upload(char_key, data, file.filename or "ref.png")
    return {"relPath": rel}
