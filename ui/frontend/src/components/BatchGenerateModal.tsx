"use client";

import React, { useMemo, useState } from "react";
import type { AngleGroup, PoseCatalogItem, ExpressionCatalogItem } from "../lib/api";
import { useAppError } from "./ErrorProvider";

/** What the dataset page receives on confirm. Prompt strings are the short descriptions
 * (the caller wraps them with the pose/expression prompt prefix at dispatch time). */
export type BatchGenerateSelection = {
  angleIds: number[];
  poseItems: { catalogId: number; label: string }[];
  posePrompts: string[];
  exprItems: { catalogId: number; label: string }[];
  exprPrompts: string[];
};

type CustomPrompt = { id: string; text: string; checked: boolean };

let promptSeq = 0;
function newPromptId(): string {
  promptSeq += 1;
  return `p${Date.now()}_${promptSeq}`;
}

function normalizeToken(s: string): string {
  return s.trim().toLowerCase();
}

function compactAngleLabel(fullLabel: string, groupTitle: string, fallbackId: number): string {
  const fullParts = fullLabel.split("·").map((p) => p.trim()).filter(Boolean);
  const groupParts = new Set(
    groupTitle.split("·").map((p) => normalizeToken(p)).filter(Boolean)
  );
  const filtered = fullParts.filter((p) => !groupParts.has(normalizeToken(p)));
  if (filtered.length > 0) return filtered.join(" · ");
  if (fullParts.length > 0) return fullParts.join(" · ");
  return `Angle ${fallbackId}`;
}

/**
 * Batch Generate: pick Angles + Expression + Pose generations for the selected dataset tiles.
 * Expression/Pose sections carry over the old per-image checklist features — checkable catalog
 * items (editable label / removable) plus custom text prompts you can add, edit inline, and remove.
 *
 * Kept mounted (hidden when closed) so edits to custom prompts / catalog overrides persist across
 * opens within a session.
 */
export function BatchGenerateModal(props: {
  open: boolean;
  title?: string;
  angleGroups: AngleGroup[];
  poseCatalog: PoseCatalogItem[];
  exprCatalog: ExpressionCatalogItem[];
  onCancel: () => void;
  onConfirm: (sel: BatchGenerateSelection) => void;
}) {
  const { open, angleGroups, poseCatalog, exprCatalog, onCancel, onConfirm } = props;
  const { askText } = useAppError();
  const title = props.title ?? "Batch Generate: angles / expression / pose for the selected tiles.";

  // ── Angles ────────────────────────────────────────────────────────────────
  const allAngleIds = useMemo(
    () => Array.from(new Set(angleGroups.flatMap((g) => g.angleIds))).sort((a, b) => a - b),
    [angleGroups]
  );
  const [anglePicked, setAnglePicked] = useState<Set<number>>(new Set());
  const [angleAnchor, setAngleAnchor] = useState<number | null>(null);

  // ── Pose / Expression catalogs (override label + hide) ──────────────────────
  const [poseSel, setPoseSel] = useState<Set<number>>(new Set());
  const [exprSel, setExprSel] = useState<Set<number>>(new Set());
  const [poseHidden, setPoseHidden] = useState<Set<number>>(new Set());
  const [exprHidden, setExprHidden] = useState<Set<number>>(new Set());
  const [poseOverrides, setPoseOverrides] = useState<Record<number, string>>({});
  const [exprOverrides, setExprOverrides] = useState<Record<number, string>>({});

  // ── Custom prompts ──────────────────────────────────────────────────────────
  const [posePrompts, setPosePrompts] = useState<CustomPrompt[]>([]);
  const [exprPrompts, setExprPrompts] = useState<CustomPrompt[]>([]);

  // ── Section collapse ────────────────────────────────────────────────────────
  const [openAngles, setOpenAngles] = useState(true);
  const [openExpr, setOpenExpr] = useState(true);
  const [openPose, setOpenPose] = useState(true);

  function onAngleCheckbox(id: number, target: boolean, ev: React.ChangeEvent<HTMLInputElement>) {
    const isShift = (ev.nativeEvent as MouseEvent).shiftKey;
    if (isShift && angleAnchor != null) {
      const a = allAngleIds.indexOf(angleAnchor);
      const b = allAngleIds.indexOf(id);
      if (a !== -1 && b !== -1) {
        const range = allAngleIds.slice(Math.min(a, b), Math.max(a, b) + 1);
        setAnglePicked((prev) => {
          const n = new Set(prev);
          for (const rid of range) target ? n.add(rid) : n.delete(rid);
          return n;
        });
        setAngleAnchor(id);
        return;
      }
    }
    setAnglePicked((prev) => {
      const n = new Set(prev);
      target ? n.add(id) : n.delete(id);
      return n;
    });
    setAngleAnchor(id);
  }

  const sectionHeader = (
    label: string,
    count: number,
    isOpen: boolean,
    setOpen: React.Dispatch<React.SetStateAction<boolean>>
  ) => (
    <div
      onClick={() => setOpen((o) => !o)}
      style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none", marginBottom: 6 }}
    >
      <span style={{ display: "inline-block", transform: isOpen ? "none" : "rotate(-90deg)", transition: "transform 0.12s" }}>▾</span>
      <span style={{ fontWeight: 500 }}>{label}</span>
      {count > 0 ? <span style={{ fontSize: 12, opacity: 0.7 }}>({count} selected)</span> : null}
    </div>
  );

  /** Render a Pose/Expression section: custom prompts (editable) + catalog checklist. */
  function renderCatalogSection(
    kind: "pose" | "expr",
    catalog: { id: number; label: string }[]
  ) {
    const sel = kind === "pose" ? poseSel : exprSel;
    const setSel = kind === "pose" ? setPoseSel : setExprSel;
    const hidden = kind === "pose" ? poseHidden : exprHidden;
    const setHidden = kind === "pose" ? setPoseHidden : setExprHidden;
    const overrides = kind === "pose" ? poseOverrides : exprOverrides;
    const setOverrides = kind === "pose" ? setPoseOverrides : setExprOverrides;
    const prompts = kind === "pose" ? posePrompts : exprPrompts;
    const setPrompts = kind === "pose" ? setPosePrompts : setExprPrompts;

    const visibleCatalog = catalog.filter((c) => !hidden.has(c.id));
    const selectedCount = sel.size + prompts.filter((p) => p.checked).length;
    const allOn =
      visibleCatalog.length > 0 &&
      visibleCatalog.every((c) => sel.has(c.id)) &&
      prompts.every((p) => p.checked);

    const toggleAll = (on: boolean) => {
      setSel(on ? new Set(visibleCatalog.map((c) => c.id)) : new Set());
      setPrompts((list) => list.map((p) => ({ ...p, checked: on })));
    };

    return (
      <div style={{ marginBottom: 14 }}>
        {sectionHeader(kind === "pose" ? "Pose" : "Expression", selectedCount,
          kind === "pose" ? openPose : openExpr,
          kind === "pose" ? setOpenPose : setOpenExpr)}
        {(kind === "pose" ? openPose : openExpr) && (
          <div style={{ border: "1px solid rgba(255,255,255,0.15)", padding: 8 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={allOn} onChange={(e) => toggleAll(e.target.checked)} />
                Select all
              </label>
              <button
                type="button"
                onClick={() =>
                  setPrompts((list) => [...list, { id: newPromptId(), text: "", checked: true }])
                }
                style={modalBtn}
              >
                + New prompt
              </button>
            </div>

            {/* Custom prompts — click to edit, × to remove. */}
            {prompts.map((p) => (
              <div key={p.id} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                <input
                  type="checkbox"
                  checked={p.checked}
                  onChange={(e) =>
                    setPrompts((list) => list.map((x) => (x.id === p.id ? { ...x, checked: e.target.checked } : x)))
                  }
                />
                <input
                  type="text"
                  value={p.text}
                  placeholder={kind === "pose" ? "describe a pose…" : "describe an expression…"}
                  onChange={(e) =>
                    setPrompts((list) => list.map((x) => (x.id === p.id ? { ...x, text: e.target.value } : x)))
                  }
                  style={{
                    flex: 1,
                    background: "#1a1a1a",
                    color: "#eee",
                    border: "1px solid rgba(255,255,255,0.2)",
                    padding: "3px 6px",
                    fontSize: 13,
                  }}
                />
                <button
                  type="button"
                  title="Remove prompt"
                  onClick={() => setPrompts((list) => list.filter((x) => x.id !== p.id))}
                  style={{ ...modalBtn, padding: "2px 8px" }}
                >
                  ×
                </button>
              </div>
            ))}

            {/* Catalog items — checkable, editable label, removable. */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: prompts.length ? 8 : 0 }}>
              {visibleCatalog.map((c) => {
                const label = overrides[c.id] ?? c.label;
                return (
                  <div
                    key={c.id}
                    style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 13, border: "1px solid rgba(255,255,255,0.12)", padding: "2px 6px" }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      void (async () => {
                        const t = await askText({
                          title: "Edit prompt",
                          message: "Prompt text:",
                          defaultValue: label,
                          confirmText: "Save",
                        });
                        if (t == null) return;
                        if (!t.trim()) {
                          // empty → remove
                          setHidden((prev) => new Set(prev).add(c.id));
                          setSel((prev) => { const n = new Set(prev); n.delete(c.id); return n; });
                          return;
                        }
                        setOverrides((o) => ({ ...o, [c.id]: t.trim() }));
                      })();
                    }}
                    title="Right-click to edit; × to remove"
                  >
                    <input
                      type="checkbox"
                      checked={sel.has(c.id)}
                      onChange={(e) =>
                        setSel((prev) => {
                          const n = new Set(prev);
                          e.target.checked ? n.add(c.id) : n.delete(c.id);
                          return n;
                        })
                      }
                    />
                    <span>{label}</span>
                    <button
                      type="button"
                      title="Remove"
                      onClick={() => {
                        setHidden((prev) => new Set(prev).add(c.id));
                        setSel((prev) => { const n = new Set(prev); n.delete(c.id); return n; });
                      }}
                      style={{ ...modalBtn, padding: "0 6px", lineHeight: "18px" }}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  const totalSelected =
    anglePicked.size +
    poseSel.size +
    exprSel.size +
    posePrompts.filter((p) => p.checked && p.text.trim()).length +
    exprPrompts.filter((p) => p.checked && p.text.trim()).length;

  function handleConfirm() {
    const poseItems = poseCatalog
      .filter((c) => !poseHidden.has(c.id) && poseSel.has(c.id))
      .map((c) => ({ catalogId: c.id, label: poseOverrides[c.id] ?? c.label }));
    const exprItems = exprCatalog
      .filter((c) => !exprHidden.has(c.id) && exprSel.has(c.id))
      .map((c) => ({ catalogId: c.id, label: exprOverrides[c.id] ?? c.label }));
    onConfirm({
      angleIds: allAngleIds.filter((id) => anglePicked.has(id)),
      poseItems,
      posePrompts: posePrompts.filter((p) => p.checked && p.text.trim()).map((p) => p.text.trim()),
      exprItems,
      exprPrompts: exprPrompts.filter((p) => p.checked && p.text.trim()).map((p) => p.text.trim()),
    });
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 10000,
        display: open ? "flex" : "none",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <div
        className="angle-modal"
        style={{
          width: 600,
          maxWidth: "100%",
          maxHeight: "88vh",
          overflow: "hidden",
          background: "#111",
          color: "#eee",
          border: "1px solid rgba(255,255,255,0.2)",
          padding: 14,
          display: "flex",
          flexDirection: "column",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 400, marginBottom: 10 }}>{title}</div>

        <div style={{ overflow: "auto", maxHeight: "64vh", paddingRight: 4 }}>
          {/* Angles */}
          <div style={{ marginBottom: 14 }}>
            {sectionHeader("Angles", anglePicked.size, openAngles, setOpenAngles)}
            {openAngles && (
              <div style={{ border: "1px solid rgba(255,255,255,0.15)", padding: 8 }}>
                {angleGroups.map((g) => {
                  const labelById = new Map((g.angles ?? []).map((a) => [a.id, a.label]));
                  const groupAllOn = g.angleIds.length > 0 && g.angleIds.every((id) => anglePicked.has(id));
                  return (
                    <div key={g.title} style={{ marginBottom: 10 }}>
                      <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                        <input
                          type="checkbox"
                          checked={groupAllOn}
                          onChange={() =>
                            setAnglePicked((prev) => {
                              const n = new Set(prev);
                              for (const id of g.angleIds) (groupAllOn ? n.delete(id) : n.add(id));
                              return n;
                            })
                          }
                        />
                        <span style={{ fontSize: 13, opacity: 0.95 }}>{g.title}</span>
                      </label>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 4 }}>
                        {g.angleIds.map((id) => (
                          <label key={id} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 13 }}>
                            <input
                              type="checkbox"
                              checked={anglePicked.has(id)}
                              onChange={(ev) => onAngleCheckbox(id, ev.target.checked, ev)}
                            />
                            {compactAngleLabel(labelById.get(id) ?? `Angle ${id}`, g.title, id)}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {renderCatalogSection("expr", exprCatalog)}
          {renderCatalogSection("pose", poseCatalog)}
        </div>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 10 }}>
          <button type="button" style={modalBtn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={totalSelected === 0}
            style={{
              ...modalBtn,
              background: totalSelected === 0 ? "transparent" : "rgba(80,120,200,0.35)",
              opacity: totalSelected === 0 ? 0.5 : 1,
              cursor: totalSelected === 0 ? "not-allowed" : "pointer",
            }}
            onClick={handleConfirm}
          >
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}

const modalBtn: React.CSSProperties = {
  borderRadius: 0,
  border: "1px solid rgba(255,255,255,0.35)",
  background: "transparent",
  color: "#eee",
  padding: "6px 14px",
  cursor: "pointer",
};
