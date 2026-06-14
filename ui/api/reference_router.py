"""
API router for the global Reference library.

The reference library is a single global store (``storage/references/``) holding
generic reference images and shared (original, skeleton) keypoint-pose pairs.
The keypoint collection is shared with the per-character pose picker so every
character can pick from the same skeleton references.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from services import audio_reference_storage, logic, reference_storage
from .ws_streaming import run_with_log_stream, safe_send_json

router = APIRouter(tags=["reference"])


# --- read ---------------------------------------------------------------------


@router.get("/reference/images")
def reference_images() -> list[dict[str, str]]:
    return [
        {"itemId": e["id"], "relPath": e["relPath"]}
        for e in reference_storage.list_images()
    ]


@router.get("/reference/keypoints")
def reference_keypoints() -> list[dict[str, str]]:
    return [
        {
            "id": e["id"],
            "referenceRelPath": e["referenceRelPath"],
            "keypointRelPath": e["keypointRelPath"],
        }
        for e in reference_storage.list_keypoints()
    ]


# --- generate / commit --------------------------------------------------------


@router.websocket("/reference/generate/ws")
async def reference_generate_ws(ws: WebSocket) -> None:
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        prompt_text = (msg.get("promptText") or "").strip()
        if not prompt_text:
            raise ValueError("promptText is required.")
        width = int(msg.get("width") or 1024)
        height = int(msg.get("height") or 1024)

        def work(log_cb: Any) -> dict[str, str]:
            return logic.generate_reference_preview(
                prompt_text=prompt_text,
                width=width,
                height=height,
                log_cb=log_cb,
            )

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.post("/reference/images/commit")
def reference_image_commit(body: dict[str, str]) -> dict[str, Any]:
    preview_rel = (body.get("previewRelPath") or "").strip()
    if not preview_rel:
        raise HTTPException(400, "previewRelPath is required.")
    try:
        entry = logic.commit_reference_image(preview_rel)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"item": {"itemId": entry["id"], "relPath": entry["relPath"]}}


@router.websocket("/reference/make_keypoint_video/ws")
async def reference_make_keypoint_video_ws(ws: WebSocket) -> None:
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        video_rel = (msg.get("videoRelPath") or "").strip()
        if not video_rel:
            raise ValueError("videoRelPath is required.")

        def work(log_cb: Any) -> dict[str, Any]:
            entry = logic.make_reference_keypoint_video(video_rel, log_cb=log_cb)
            return {
                "item": {
                    "id": entry["id"],
                    "videoRelPath": entry["videoRelPath"],
                    "fps": entry.get("fps", 24),
                    "frameSequence": entry.get("frameSequence") or {},
                }
            }

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


@router.websocket("/reference/make_keypoint/ws")
async def reference_make_keypoint_ws(ws: WebSocket) -> None:
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        image_rel = (msg.get("imageRelPath") or "").strip()
        if not image_rel:
            raise ValueError("imageRelPath is required.")

        def work(log_cb: Any) -> dict[str, Any]:
            entry = logic.make_reference_keypoint(image_rel, log_cb=log_cb)
            return {
                "item": {
                    "id": entry["id"],
                    "referenceRelPath": entry["referenceRelPath"],
                    "keypointRelPath": entry["keypointRelPath"],
                }
            }

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


# --- new angle ----------------------------------------------------------------


@router.get("/reference/angle_groups")
def reference_angle_groups() -> list[dict[str, Any]]:
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
            "angles": [
                {"id": aid, "label": logic.angle_ui_label(aid) or f"Angle {aid}"}
                for aid in ids
            ],
        }
        for t, ids in groups
    ]


@router.websocket("/reference/make_angle/ws")
async def reference_make_angle_ws(ws: WebSocket) -> None:
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        image_rel = (msg.get("imageRelPath") or "").strip()
        if not image_rel:
            raise ValueError("imageRelPath is required.")
        angle_id = int(msg.get("angleId"))

        def work(log_cb: Any) -> dict[str, Any]:
            entry = logic.make_reference_angle(image_rel, angle_id, log_cb=log_cb)
            return {"item": {"itemId": entry["id"], "relPath": entry["relPath"]}}

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


# --- reorder / delete ---------------------------------------------------------


@router.post("/reference/images/reorder")
def reference_images_reorder(body: dict[str, list[str]]) -> dict[str, bool]:
    order = body.get("order") or []
    reference_storage.set_images_order([str(x) for x in order])
    return {"ok": True}


@router.get("/reference/keypoints/layout")
def reference_keypoints_layout() -> dict[str, Any]:
    return reference_storage.get_keypoints_layout()


@router.post("/reference/keypoints/reorder")
def reference_keypoints_reorder(body: dict[str, Any]) -> dict[str, bool]:
    scope = str(body.get("scope") or "flat").strip()
    order = [str(x) for x in (body.get("order") or [])]
    if scope == "folder":
        folder_id = str(body.get("folderId") or "").strip()
        if not folder_id:
            raise HTTPException(400, "folderId is required for folder scope.")
        reference_storage.set_keypoint_folder_order(folder_id, order)
    elif scope == "root":
        reference_storage.set_keypoints_root_order(order)
    else:
        reference_storage.set_keypoints_order(order)
    return {"ok": True}


class KeypointFolderBody(BaseModel):
    name: str
    itemIds: list[str]
    parentFolderId: str | None = None


class KeypointFolderRenameBody(BaseModel):
    name: str


class KeypointFolderAssignBody(BaseModel):
    folderId: str | None = None
    itemIds: list[str]


@router.post("/reference/keypoints/folders")
def reference_keypoints_create_folder(body: KeypointFolderBody) -> dict[str, Any]:
    try:
        folder = reference_storage.create_keypoint_folder(
            body.name, body.itemIds, body.parentFolderId
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"folder": folder}


@router.patch("/reference/keypoints/folders/{folder_id}")
def reference_keypoints_rename_folder(
    folder_id: str, body: KeypointFolderRenameBody
) -> dict[str, Any]:
    try:
        folder = reference_storage.rename_keypoint_folder(folder_id, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"folder": folder}


@router.post("/reference/keypoints/{keypoint_id}/copy")
def reference_keypoint_copy(keypoint_id: str) -> dict[str, Any]:
    try:
        entry = reference_storage.duplicate_keypoint(keypoint_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {
        "item": {
            "id": entry["id"],
            "referenceRelPath": entry["referenceRelPath"],
            "keypointRelPath": entry["keypointRelPath"],
        }
    }


@router.post("/reference/keypoints/video/{video_id}/copy")
def reference_keypoint_video_copy(video_id: str) -> dict[str, Any]:
    try:
        entry = reference_storage.duplicate_keypoint_video(video_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {
        "item": {
            "id": entry["id"],
            "videoRelPath": entry["videoRelPath"],
            "fps": entry.get("fps", 24),
            "frameSequence": entry.get("frameSequence") or {},
        }
    }


@router.post("/reference/keypoints/folders/assign")
def reference_keypoints_assign_folder(body: KeypointFolderAssignBody) -> dict[str, bool]:
    try:
        reference_storage.assign_keypoints_to_folder(body.folderId, body.itemIds)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True}


@router.delete("/reference/keypoints/folders/{folder_id}")
def reference_keypoints_delete_folder(folder_id: str) -> dict[str, bool]:
    ok = reference_storage.delete_keypoint_folder(folder_id)
    if not ok:
        raise HTTPException(404, "Folder not found.")
    return {"ok": True}


@router.get("/reference/keypoints/video/{video_id}")
def reference_keypoint_video_get(video_id: str) -> dict[str, Any]:
    entry = reference_storage.get_keypoint_video(video_id)
    if not entry:
        raise HTTPException(404, "Video reference not found.")
    return {
        "id": entry["id"],
        "videoRelPath": entry["videoRelPath"],
        "fps": entry.get("fps", 24),
        "frameSequence": entry.get("frameSequence") or {},
    }


class KeypointVideoStripBody(BaseModel):
    frameSequence: dict[str, Any]


@router.put("/reference/keypoints/video/{video_id}/frame_sequence")
def reference_keypoint_video_update_strip(
    video_id: str,
    body: KeypointVideoStripBody,
) -> dict[str, Any]:
    try:
        entry = reference_storage.update_keypoint_video_strip(
            video_id, body.frameSequence
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {
        "id": entry["id"],
        "videoRelPath": entry["videoRelPath"],
        "fps": entry.get("fps", 24),
        "frameSequence": entry.get("frameSequence") or {},
    }


@router.delete("/reference/keypoints/video/{video_id}")
def reference_keypoint_video_delete(video_id: str) -> dict[str, bool]:
    ok = reference_storage.delete_keypoint_video(video_id)
    if not ok:
        raise HTTPException(404, "Video reference not found.")
    return {"ok": True}


@router.delete("/reference/images/{image_id}")
def reference_image_delete(image_id: str) -> dict[str, bool]:
    return {"ok": reference_storage.delete_image(image_id)}


@router.delete("/reference/keypoints/{keypoint_id}")
def reference_keypoint_delete(keypoint_id: str) -> dict[str, bool]:
    return {"ok": reference_storage.delete_keypoint(keypoint_id)}


# --- audio gallery -----------------------------------------------------------


@router.get("/reference/audio/layout")
def reference_audio_layout() -> dict[str, Any]:
    return audio_reference_storage.get_audio_layout()


@router.websocket("/reference/audio/generate/ws")
async def reference_audio_generate_ws(ws: WebSocket) -> None:
    await ws.accept()
    try:
        msg = await ws.receive_json()
    except WebSocketDisconnect:
        return
    try:
        mode = (msg.get("mode") or "audio").strip()
        prompt = (msg.get("prompt") or "").strip()
        style = (msg.get("style") or "").strip()
        lyrics = msg.get("lyrics") or ""
        duration_sec = float(msg.get("duration") or 120)

        def work(log_cb: Any) -> dict[str, Any]:
            return logic.generate_reference_audio(
                mode=mode,
                prompt=prompt,
                style=style,
                lyrics=str(lyrics),
                duration_sec=duration_sec,
                log_cb=log_cb,
            )

        result, err = await run_with_log_stream(ws, work)
        if err:
            await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
        else:
            await safe_send_json(ws, {"type": "done", "ok": True, "result": result})
    except Exception as e:
        await safe_send_json(ws, {"type": "done", "ok": False, "error": str(e)})


class AudioFolderBody(BaseModel):
    name: str
    itemIds: list[str]


@router.post("/reference/audio/folders")
def reference_audio_create_folder(body: AudioFolderBody) -> dict[str, Any]:
    try:
        folder = audio_reference_storage.create_audio_folder(body.name, body.itemIds)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"folder": folder}


@router.post("/reference/audio/reorder")
def reference_audio_reorder(body: dict[str, Any]) -> dict[str, bool]:
    scope = str(body.get("scope") or "flat").strip()
    order = [str(x) for x in (body.get("order") or [])]
    if scope == "folder":
        folder_id = str(body.get("folderId") or "").strip()
        if not folder_id:
            raise HTTPException(400, "folderId is required for folder scope.")
        audio_reference_storage.set_audio_folder_order(folder_id, order)
    elif scope == "root":
        audio_reference_storage.set_audio_root_order(order)
    else:
        audio_reference_storage.set_audio_root_order(order)
    return {"ok": True}


@router.delete("/reference/audio/folders/{folder_id}")
def reference_audio_delete_folder(folder_id: str) -> dict[str, bool]:
    ok = audio_reference_storage.delete_audio_folder(folder_id)
    if not ok:
        raise HTTPException(404, "Folder not found.")
    return {"ok": True}


@router.delete("/reference/audio/{audio_id}")
def reference_audio_delete(audio_id: str) -> dict[str, bool]:
    return {"ok": audio_reference_storage.delete_audio_item(audio_id)}
