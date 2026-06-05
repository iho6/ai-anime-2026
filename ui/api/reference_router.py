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

from services import logic, reference_storage
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


@router.post("/reference/keypoints/reorder")
def reference_keypoints_reorder(body: dict[str, list[str]]) -> dict[str, bool]:
    order = body.get("order") or []
    reference_storage.set_keypoints_order([str(x) for x in order])
    return {"ok": True}


@router.delete("/reference/images/{image_id}")
def reference_image_delete(image_id: str) -> dict[str, bool]:
    return {"ok": reference_storage.delete_image(image_id)}


@router.delete("/reference/keypoints/{keypoint_id}")
def reference_keypoint_delete(keypoint_id: str) -> dict[str, bool]:
    return {"ok": reference_storage.delete_keypoint(keypoint_id)}
