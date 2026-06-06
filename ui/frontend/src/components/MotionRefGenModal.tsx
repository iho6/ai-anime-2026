"use client";

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  apiMotionRefRenderFrame,
  apiMotionRefRenderJoints,
  apiMotionRefJoints,
  apiMotionRefList,
  apiMotionRefDelete,
  apiUploadStaging,
  MotionRefManifest,
  MotionRefListItem,
  MotionRefSegment,
  assetUrlFromRelPath,
  runMotionRefGenerateWsJob,
  runReferenceMakeKeypointWsJob,
  PoseReference,
} from "../lib/api";
import { useJobRunSession } from "../hooks/useJobRunSession";
import type { SharedLogStreamHandle } from "./SharedLogStream";
import { ConnectedJobRunModal } from "./ConnectedJobRunModal";
import { useAppError } from "./ErrorProvider";
import { SkeletonViewer3D, SkeletonViewer3DHandle, CameraState } from "./motionRef/SkeletonViewer3D";
import { MotionTimeline } from "./motionRef/MotionTimeline";

const DEFAULT_SEGMENTS: MotionRefSegment[] = [
  { text: "", duration: 3.0 },
];

export function MotionRefGenModal(props: {
  open: boolean;
  charKey: string;
  /** Return to Add Reference Image modal. */
  onBack?: () => void;
  onClose: () => void;
  /** Called each time a keypoint is saved — adds to the unified pose gallery. */
  onKeypointsMade?: (ref: PoseReference) => void;
}) {
  const { open, charKey, onBack, onClose, onKeypointsMade } = props;
  const { showError } = useAppError();

  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const {
    running: busy,
    beginSession,
    endSession,
    failSession,
    pushLog,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);

  const skeletonRef = useRef<SkeletonViewer3DHandle | null>(null);

  // ── Motion data ────────────────────────────────────────────────────────────
  const [segments, setSegments] = useState<MotionRefSegment[]>(DEFAULT_SEGMENTS);
  const [diffusionSteps, setDiffusionSteps] = useState(100);
  const [manifest, setManifest] = useState<MotionRefManifest | null>(null);
  const [joints3d, setJoints3d] = useState<number[][][] | null>(null);

  // ── Motion gallery (persisted motions) ────────────────────────────────────
  const [motions, setMotions] = useState<MotionRefListItem[]>([]);
  const [motionCtxMenu, setMotionCtxMenu] = useState<{
    motionKey: string;
    x: number;
    y: number;
  } | null>(null);

  // ── Playback ───────────────────────────────────────────────────────────────
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);
  const anchorRef = useRef<{ wall: number; head: number; fps: number } | null>(null);

  // ── Camera state ───────────────────────────────────────────────────────────
  const [cameraState, setCameraState] = useState<CameraState>({
    azimuth: 20,
    elevation: 15,
    distance: 3,
  });

  const totalFrames = joints3d?.length ?? 0;

  // ── Load saved motions on open ─────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    apiMotionRefList().then(setMotions).catch(() => {});
  }, [open]);

  // ── Playback engine ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || !joints3d || joints3d.length === 0) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      anchorRef.current = null;
      return;
    }
    const fps = manifest?.fps ?? 30;
    anchorRef.current = { wall: performance.now(), head: frameIndex, fps };
    const tick = () => {
      const a = anchorRef.current;
      if (!a) return;
      const elapsed = (performance.now() - a.wall) / 1000;
      const nextHead = a.head + elapsed * a.fps;
      const clamped = Math.floor(nextHead) % joints3d.length;
      setFrameIndex(clamped);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  useEffect(() => {
    if (!joints3d || !joints3d[frameIndex]) return;
    skeletonRef.current?.setFrame(joints3d[frameIndex]);
  }, [frameIndex, joints3d]);

  useEffect(() => {
    if (!open) {
      setPlaying(false);
      setFrameIndex(0);
    }
  }, [open]);

  // ── Generation (fresh — no starting pose conditioning) ────────────────────
  async function runGenerate() {
    if (!segments.some((s) => s.text.trim())) {
      showError({ message: "Enter at least one motion prompt before generating." });
      return;
    }
    setPlaying(false);
    setManifest(null);
    setJoints3d(null);
    setFrameIndex(0);
    skeletonRef.current?.resetAll();

    beginSession({ title: "Generating motion (KiMoD)", clearLog: true });
    await Promise.resolve();
    pushLog("Starting KiMoD worker (model loads on first run)…");

    try {
      const done = await runMotionRefGenerateWsJob({
        motionName: segments[0].text.trim().slice(0, 40) || "motion",
        segments: segments.filter((s) => s.text.trim()),
        diffusionSteps,
        onLogLine: (line) => pushLog(line),
      });

      if (!done.ok || !done.result) {
        throw new Error(done.error || "Generation returned no result.");
      }

      const mf = done.result;
      setManifest(mf);

      pushLog("Loading joint data…");
      const buf = await apiMotionRefJoints(mf.motionKey);
      const text = await decompressGzip(buf);
      const j3d: number[][][] = JSON.parse(text);
      setJoints3d(j3d);
      setFrameIndex(0);
      if (j3d.length > 0 && skeletonRef.current) {
        skeletonRef.current.setFrame(j3d[0]);
      }
      pushLog(`Ready — ${j3d.length} frames @ ${mf.fps} fps.`);
      endSession();

      // Add to motion gallery list (prepend).
      const newEntry: MotionRefListItem = {
        motionKey: mf.motionKey,
        fps: mf.fps,
        frameCount: j3d.length,
        jointCount: 77,
        thumbnailRelPath: "",
        segments: mf.segments ?? segments.filter((s) => s.text.trim()),
      };
      setMotions((prev) => [newEntry, ...prev.filter((m) => m.motionKey !== mf.motionKey)]);
    } catch (e) {
      failSession(e, "Motion generation failed.");
    }
  }

  // ── Load a saved motion into the viewer ───────────────────────────────────
  async function loadMotion(item: MotionRefListItem) {
    if (busy) return;
    setPlaying(false);
    setManifest({ motionKey: item.motionKey, fps: item.fps, frameCount: item.frameCount, segments: item.segments ?? [] });
    beginSession({ title: "Loading motion…", clearLog: false });
    await Promise.resolve();
    try {
      const buf = await apiMotionRefJoints(item.motionKey);
      const text = await decompressGzip(buf);
      const j3d: number[][][] = JSON.parse(text);
      setJoints3d(j3d);
      setFrameIndex(0);
      if (j3d.length > 0 && skeletonRef.current) skeletonRef.current.setFrame(j3d[0]);
      pushLog(`Loaded — ${j3d.length} frames @ ${item.fps} fps.`);
      endSession();
    } catch (e) {
      failSession(e, "Could not load motion.");
    }
  }

  // ── Delete a motion from the gallery ─────────────────────────────────────
  async function deleteMotion(motionKey: string) {
    setMotionCtxMenu(null);
    try {
      await apiMotionRefDelete(motionKey);
      setMotions((prev) => prev.filter((m) => m.motionKey !== motionKey));
      if (manifest?.motionKey === motionKey) {
        setManifest(null);
        setJoints3d(null);
        setFrameIndex(0);
        skeletonRef.current?.resetAll();
      }
    } catch {
      showError({ message: "Could not delete motion." });
    }
  }

  // ── Save shot → unified keypoint pose gallery ─────────────────────────────
  // Both paths (motion frame render and puppet canvas capture) run ControlNet
  // and deliver the result via onKeypointsMade.
  async function saveShot() {
    const cam = skeletonRef.current?.getCameraState() ?? cameraState;

    if (!manifest) {
      // Puppet canvas capture → ControlNet
      const dataUrl = skeletonRef.current?.captureFrame();
      if (!dataUrl) {
        showError({ message: "Could not capture canvas. Try again." });
        return;
      }
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], `puppet_shot.png`, { type: "image/png" });
      beginSession({ title: "Saving puppet shot", clearLog: false });
      await Promise.resolve();
      pushLog("Uploading canvas capture…");
      try {
        const { relPath } = await apiUploadStaging({ charKey, file });
        pushLog("Running ControlNet pose detection…");
        const done = await runReferenceMakeKeypointWsJob({
          imageRelPath: relPath,
          onLogLine: (line) => pushLog(line),
        });
        if (!done.ok || !done.result?.item) {
          throw new Error(done.error || "Keypoint detection returned no result.");
        }
        onKeypointsMade?.(done.result.item);
        pushLog("Shot saved to pose gallery.");
        endSession();
      } catch (e) {
        failSession(e, "Could not save puppet shot.");
      }
      return;
    }

    // Motion frame → render → ControlNet
    beginSession({ title: "Saving shot", clearLog: false });
    await Promise.resolve();
    pushLog(`Rendering frame ${frameIndex} at az=${cam.azimuth.toFixed(0)}°…`);
    try {
      const { shotRelPath } = await apiMotionRefRenderFrame({
        motionKey: manifest.motionKey,
        frameIndex,
        azimuth: cam.azimuth,
        elevation: cam.elevation,
        width: 512,
        height: 512,
        shotName: `shot_f${frameIndex}_${Date.now()}`,
      });
      pushLog("Running ControlNet pose detection…");
      const done = await runReferenceMakeKeypointWsJob({
        imageRelPath: shotRelPath,
        onLogLine: (line) => pushLog(line),
      });
      if (!done.ok || !done.result?.item) {
        throw new Error(done.error || "Keypoint detection returned no result.");
      }
      onKeypointsMade?.(done.result.item);
      pushLog("Shot saved to pose gallery.");
      endSession();
    } catch (e) {
      failSession(e, "Could not save shot.");
    }
  }

  // ── Save puppet pose (GPU-free matplotlib render) ─────────────────────────
  async function savePuppetPose() {
    const sk = skeletonRef.current;
    if (!sk) return;
    const joints = sk.getJoints();
    const cam = sk.getCameraState();
    beginSession({ title: "Saving puppet pose", clearLog: false });
    await Promise.resolve();
    pushLog("Rendering skeleton pose (no GPU needed)…");
    try {
      const { shotRelPath } = await apiMotionRefRenderJoints({
        joints,
        azimuth: cam.azimuth,
        elevation: cam.elevation,
        width: 512,
        height: 512,
      });
      onKeypointsMade?.({
        id: 0,
        referenceRelPath: shotRelPath,
        keypointRelPath: shotRelPath,
      });
      pushLog("Pose saved to pose gallery.");
      endSession();
      onBack ? onBack() : onClose();
    } catch (e) {
      failSession(e, "Could not save puppet pose.");
    }
  }

  const timeLabel = useMemo(() => {
    if (totalFrames === 0) return "— / —";
    const fps = manifest?.fps ?? 30;
    const cur = (frameIndex / fps).toFixed(1);
    const tot = (totalFrames / fps).toFixed(1);
    return `${frameIndex} / ${totalFrames - 1}  (${cur}s / ${tot}s)`;
  }, [frameIndex, totalFrames, manifest]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          // Close any open context menu when clicking elsewhere.
          if (motionCtxMenu) { e.preventDefault(); setMotionCtxMenu(null); }
        }}
        style={{
          background: "#111",
          color: "#eee",
          border: "1px solid rgba(255,255,255,0.2)",
          width: 900,
          maxWidth: "96vw",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          font: "inherit",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                style={{ ...headerBtn, fontSize: 13 }}
                title="Back to Add Reference Image"
              >
                ← Back
              </button>
            )}
            <span style={{ fontWeight: 600, fontSize: 14 }}>Motion Ref Gen</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "#888", cursor: "pointer", fontSize: 18 }}
          >
            ×
          </button>
        </div>

        {/* Top: viewer + timeline */}
        <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          {/* 3D viewer */}
          <div style={{ padding: 12, borderRight: "1px solid rgba(255,255,255,0.1)", flexShrink: 0 }}>
            <SkeletonViewer3D
              ref={skeletonRef}
              width={380}
              height={290}
              onCameraChange={(s) => setCameraState(s)}
            />
            <div style={{ fontSize: 10, color: "#555", marginTop: 4, textAlign: "center" }}>
              Click joint to select · Drag joint to move · Drag empty area to orbit · Scroll to zoom
            </div>
          </div>

          {/* Motion timeline */}
          <div style={{ flex: 1, padding: 12, overflow: "auto" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#aaa", marginBottom: 8 }}>
              Motion segments
            </div>
            <MotionTimeline segments={segments} onChange={setSegments} disabled={busy} />
          </div>
        </div>

        {/* Playback controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <button type="button" onClick={() => { setPlaying(false); setFrameIndex(0); }} style={controlBtn} title="Go to start">◀◀</button>
          <button type="button" onClick={() => setPlaying((p) => !p)} style={controlBtn} disabled={totalFrames === 0}>
            {playing ? "⏸" : "▶"}
          </button>
          <button type="button" onClick={() => setFrameIndex((i) => Math.min(totalFrames - 1, i + 1))} style={controlBtn} disabled={totalFrames === 0} title="Step forward">▶▶</button>
          <span style={{ fontSize: 11, color: "#aaa", fontVariantNumeric: "tabular-nums", minWidth: 130 }}>{timeLabel}</span>
          <input
            type="range" min={0} max={Math.max(0, totalFrames - 1)} value={frameIndex}
            onChange={(e) => { setPlaying(false); setFrameIndex(Number(e.target.value)); }}
            disabled={totalFrames === 0} style={{ flex: 1 }}
          />
        </div>

        {/* Puppet actions */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)", flexWrap: "wrap" }}>
          <button
            type="button" onClick={() => void savePuppetPose()} disabled={busy}
            title="Save current puppet pose as a keypoint reference — no GPU required"
            style={{ ...actionBtn, background: "rgba(100,220,100,0.12)", fontWeight: 600 }}
          >
            Save Pose
          </button>
          <button
            type="button" onClick={() => skeletonRef.current?.resetAll()} disabled={busy}
            title="Reset pose and camera to defaults" style={actionBtn}
          >
            Reset
          </button>
          <span style={{ fontSize: 10, color: "#555", marginLeft: 4 }}>Drag joints to pose · no GPU required</span>
        </div>

        {/* Generation + Save Shot row */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px", flexWrap: "wrap", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <button
            type="button" onClick={() => void runGenerate()} disabled={busy}
            title="Generate a fresh KiMoD motion sequence from the text segments"
            style={{ ...actionBtn, fontWeight: 600 }}
          >
            Generate
          </button>
          <label style={{ fontSize: 11, color: "#aaa", display: "flex", alignItems: "center", gap: 4 }}>
            Diffusion steps
            <input
              type="number" min={10} max={500} step={10} value={diffusionSteps}
              onChange={(e) => setDiffusionSteps(Math.max(10, Number(e.target.value) || 100))}
              disabled={busy}
              style={{ width: 64, padding: "3px 6px", background: "#222", color: "#eee", border: "1px solid rgba(255,255,255,0.2)", font: "inherit", fontSize: 12 }}
            />
          </label>
          <div style={{ flex: 1 }} />
          <button
            type="button" onClick={() => void saveShot()} disabled={busy}
            title={manifest
              ? `Save frame ${frameIndex} at current camera angle → ControlNet → pose gallery`
              : "Capture puppet canvas → ControlNet → pose gallery (needs GPU)"}
            style={{ ...actionBtn, background: "rgba(255,209,102,0.15)" }}
          >
            {manifest ? `Save Shot  (f${frameIndex} · Az ${cameraState.azimuth.toFixed(0)}°)` : "Save Shot  (puppet)"}
          </button>
        </div>

        {/* Motion Gallery */}
        <div style={{ padding: "10px 16px" }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#aaa", marginBottom: 8 }}>
            Motion Gallery
          </div>
          {motions.length === 0 ? (
            <div style={{ fontSize: 12, color: "#555", padding: "12px 0" }}>
              No saved motions — generate one above.
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {motions.map((m) => {
                const isActive = manifest?.motionKey === m.motionKey;
                const label = m.segments?.[0]?.text?.slice(0, 28) || m.motionKey.slice(0, 20);
                return (
                  <div
                    key={m.motionKey}
                    onClick={() => void loadMotion(m)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMotionCtxMenu({ motionKey: m.motionKey, x: e.clientX, y: e.clientY });
                    }}
                    title={`${label} — ${m.frameCount} frames @ ${m.fps} fps\nClick to load · Right-click to delete`}
                    style={{
                      width: 90,
                      cursor: busy ? "not-allowed" : "pointer",
                      border: isActive ? "1px solid rgba(255,209,102,0.7)" : "1px solid rgba(255,255,255,0.15)",
                      background: isActive ? "rgba(255,209,102,0.08)" : "rgba(255,255,255,0.04)",
                      padding: 6,
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      userSelect: "none",
                    }}
                  >
                    {m.thumbnailRelPath ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={assetUrlFromRelPath(m.thumbnailRelPath)}
                        alt=""
                        style={{ width: "100%", aspectRatio: "1", objectFit: "cover" }}
                        draggable={false}
                      />
                    ) : (
                      <div style={{ width: "100%", aspectRatio: "1", background: "#222", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>
                        🎞
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
                    <div style={{ fontSize: 9, color: "#666" }}>{m.frameCount}f · {m.fps}fps</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Motion context menu */}
      {motionCtxMenu && (
        <div
          style={{
            position: "fixed",
            top: motionCtxMenu.y,
            left: motionCtxMenu.x,
            background: "#1e1e1e",
            border: "1px solid rgba(255,255,255,0.2)",
            zIndex: 1200,
            minWidth: 120,
          }}
          onMouseLeave={() => setMotionCtxMenu(null)}
        >
          <button
            type="button"
            onClick={() => void deleteMotion(motionCtxMenu.motionKey)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 14px",
              background: "transparent",
              color: "#eee",
              border: "none",
              textAlign: "left",
              cursor: "pointer",
              font: "inherit",
              fontSize: 13,
            }}
          >
            Delete motion
          </button>
        </div>
      )}

      <ConnectedJobRunModal modal={jobModalProps} logRef={logRef} />
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function decompressGzip(buf: ArrayBuffer): Promise<string> {
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(buf);
    writer.close();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { out.set(c, offset); offset += c.length; }
    return new TextDecoder().decode(out);
  }
  return new TextDecoder().decode(buf);
}

const controlBtn: React.CSSProperties = {
  background: "transparent",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.3)",
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
  fontSize: 13,
};

const actionBtn: React.CSSProperties = {
  background: "transparent",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.4)",
  padding: "7px 14px",
  cursor: "pointer",
  font: "inherit",
};

const headerBtn: React.CSSProperties = {
  background: "transparent",
  color: "#aaa",
  border: "1px solid rgba(255,255,255,0.2)",
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
};
