from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from services import logic

from .preview_storage import save_staging_upload
from .storage_paths import resolve_storage_rel_file, storage_rel_from_abs
from .ws_streaming import run_with_log_stream, safe_send_json

logger = logging.getLogger(__name__)

router = APIRouter(tags=["detail-expression"])


class ExpressionCatalogItem(BaseModel):
    id: int
    label: str
    promptText: str


@router.get(
    "/detail/{char_key}/expression/catalog",
    response_model=list[ExpressionCatalogItem],
)
def expression_catalog(char_key: str) -> list[ExpressionCatalogItem]:
    if not char_key:
        raise HTTPException(400, "Missing char_key")
    out: list[ExpressionCatalogItem] = []
    for pid, opt in sorted(logic.EXPRESSION_BY_ID.items()):
        out.append(
            ExpressionCatalogItem(id=pid, label=opt.label, promptText=opt.prompt_text)
        )
    return out


@router.get("/detail/{char_key}/expression/angle_groups")
def expression_angle_groups(char_key: str) -> list[dict[str, Any]]:
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


class ExpressionHiddenBody(BaseModel):
    itemIds: list[str]
    hidden: bool


@router.post("/detail/{char_key}/expression/gallery/hidden")
def expression_gallery_hidden(char_key: str, body: ExpressionHiddenBody) -> dict[str, bool]:
    logic.set_expression_gallery_hidden(char_key, body.itemIds, body.hidden)
    return {"ok": True}


class ExpressionUiStateBody(BaseModel):
    order: list[str]
    hiddenKeys: list[str]


@router.post("/detail/{char_key}/expression/gallery/ui_state")
def expression_gallery_ui_state(char_key: str, body: ExpressionUiStateBody) -> dict[str, bool]:
    logic.set_expression_gallery_ui_state(char_key, body.order, body.hiddenKeys)
    return {"ok": True}


class ExpressionRenameBody(BaseModel):
    oldKey: str
    newLabel: str


@router.post("/detail/{char_key}/expression/folder/rename")
def expression_folder_rename(char_key: str, body: ExpressionRenameBody) -> dict[str, str]:
    new_key = logic.rename_expression_folder(char_key, body.oldKey, body.newLabel.strip())
    return {"newKey": new_key}


class ExpressionDeleteBody(BaseModel):
    exprKey: str


@router.post("/detail/{char_key}/expression/folder/delete")
def expression_folder_delete(char_key: str, body: ExpressionDeleteBody) -> dict[str, bool]:
    logic.delete_expression_folder(char_key, body.exprKey)
    return {"ok": True}


class ExpressionAngleDeleteBody(BaseModel):
    exprKey: str
    relPaths: list[str]


@router.post("/detail/{char_key}/expression/angles/delete")
def expression_angles_delete(
    char_key: str, body: ExpressionAngleDeleteBody
) -> dict[str, int]:
    deleted = logic.delete_expression_angle_images(char_key, body.exprKey, body.relPaths)
    return {"deleted": int(deleted)}


class ExpressionAngleOrderBody(BaseModel):
    filenames: list[str]


@router.post("/detail/{char_key}/expression/{expr_key}/angles/order")
def expression_angles_order(
    char_key: str, expr_key: str, body: ExpressionAngleOrderBody
) -> dict[str, bool]:
    logic.set_expression_angle_order(char_key, expr_key, body.filenames)
    return {"ok": True}


@router.post("/detail/{char_key}/expression/import_starting")
async def expression_import_starting(
    char_key: str,
    file: UploadFile = File(...),
    expression_folder_name: str = Form(""),
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
        name = (expression_folder_name or "").strip() or Path(file.filename or "import").stem
        rel = logic.import_external_expression_starting_image(char_key, name, tmp_path)
    finally:
        tmp_path.unlink(missing_ok=True)
    return {"relPath": rel, "exprKey": logic.EXPR_FLAT_BUCKET}


class ExpressionImportStartingFromRelBody(BaseModel):
    sourceRelPath: str
    expression_folder_name: str = ""


@router.post("/detail/{char_key}/expression/import_starting_from_rel")
def expression_import_starting_from_rel(
    char_key: str, body: ExpressionImportStartingFromRelBody
) -> dict[str, str]:
    """Copy a pose/expression gallery file into ``expressions/`` without multipart upload."""
    if not char_key.strip():
        raise HTTPException(400, "Missing char_key")
    src = (body.sourceRelPath or "").strip()
    if not src:
        raise HTTPException(400, "sourceRelPath required")
    try:
        rel = logic.import_expression_starting_from_gallery_rel_path(
            char_key,
            src,
            expression_folder_name=(body.expression_folder_name or "").strip() or None,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"relPath": rel, "exprKey": logic.EXPR_FLAT_BUCKET}


@router.post("/detail/{char_key}/expression/import_multi_angle")
async def expression_import_multi_angle(
    char_key: str,
    expr_key: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, str]:
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty file")
    rel = save_staging_upload(char_key, data, file.filename or "angle.png")
    abs_path = str(resolve_storage_rel_file(rel))
    logic.import_manual_multi_angle_image_for_expression(char_key, expr_key, abs_path)
    return {"ok": True, "stagingRelPath": rel}


@router.websocket("/detail/{char_key}/expression/ws")
async def expression_job_ws(ws: WebSocket, char_key: str) -> None:
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

    try:
        if job == "generate_prompts":
            prompts = msg.get("prompts") or []
            if not isinstance(prompts, list):
                raise ValueError("prompts must be a list")
            texts = [str(p).strip() for p in prompts if str(p).strip()]
            if not texts:
                raise ValueError("No prompts provided.")
            input_abs = base_abs_from_msg()

            def work(log_cb):
                rows = logic.generate_expression_starting_images_from_prompts(
                    char_key, input_abs, texts, log_cb=log_cb
                )
                last_abs = rows[-1][0] if rows else input_abs
                rels = [r[1] for r in rows]
                return {
                    "relPaths": rels,
                    "exprKeys": [logic.EXPR_FLAT_BUCKET] * len(rels),
                    "lastInputRelPath": storage_rel_from_abs(last_abs),
                    "firstExprRelPath": rows[0][1] if rows else None,
                    "firstExprKey": logic.EXPR_FLAT_BUCKET,
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

            def work2(log_cb):
                results: list[dict[str, Any]] = []
                last_path = input_abs
                total = len(items)
                for idx, it in enumerate(items):
                    if log_cb:
                        log_cb(f"Generating expression {idx + 1}/{total}…")
                    pid = int(it.get("catalogId"))
                    if pid not in logic.EXPRESSION_BY_ID:
                        raise ValueError(f"Unknown expression id: {pid}")
                    label = str(it.get("label") or "").strip()
                    if not label:
                        label = logic.EXPRESSION_BY_ID[pid].label
                    prompt_override = logic.build_expression_prompt_from_label(label)
                    out_path, rel = logic.generate_expression_starting_image_from_prompt(
                        char_key,
                        pid,
                        input_abs,
                        prompt_override,
                        log_cb=log_cb,
                    )
                    last_path = out_path
                    results.append(
                        {
                            "exprKey": logic.EXPR_FLAT_BUCKET,
                            "relPath": rel,
                            "path": out_path,
                        }
                    )
                return {
                    "rows": results,
                    "lastInputRelPath": storage_rel_from_abs(last_path),
                    "firstExprKey": logic.EXPR_FLAT_BUCKET,
                    "firstExprRelPath": results[0]["relPath"] if results else None,
                }

            result, err = await run_with_log_stream(ws, work2)
            if err:
                await safe_send_json(ws, {"type": "done", "ok": False, "error": err})
            else:
                await safe_send_json(
                    ws, {"type": "done", "ok": True, "result": result}
                )

        elif job == "angles":
            expr_keys = msg.get("exprKeys") or []
            if not isinstance(expr_keys, list):
                expr_keys = []
            if not expr_keys:
                expr_keys = [logic.EXPR_FLAT_BUCKET]
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
                    "expression ws angles: char=%s keys=%s angle_ids=%s input_paths=%d",
                    char_key,
                    expr_keys,
                    angle_ids,
                    len(input_abs_list),
                )
                for ek in expr_keys:
                    logic.run_expression_multi_angle_ws_job(
                        char_key,
                        ek,
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
        elif job == "ai_edit_expression":
            expr_key = (msg.get("exprKey") or "").strip() or logic.EXPR_FLAT_BUCKET
            source_rel_path = (msg.get("sourceRelPath") or "").strip()
            prompt_text = (msg.get("promptText") or "").strip()
            if not source_rel_path:
                raise ValueError("sourceRelPath required")
            if not prompt_text:
                raise ValueError("promptText required")

            source_abs_path = str(resolve_storage_rel_file(source_rel_path))
            mask_abs_path = logic.decode_mask_png_to_temp_file(
                msg.get("maskPngBase64")
            )

            def work(log_cb):
                try:
                    new_abs = logic.ai_edit_expression_in_bucket(
                        char_key,
                        expr_key=expr_key,
                        source_image_abs_path=source_abs_path,
                        prompt_text=prompt_text,
                        mask_abs_path=mask_abs_path,
                        log_cb=log_cb,
                    )
                finally:
                    if mask_abs_path:
                        Path(mask_abs_path).unlink(missing_ok=True)
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
