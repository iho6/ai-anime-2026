"use client";

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  apiMotionRefSaveShotImage,
  apiMotionRefMesh,
  apiMotionRefMeshFaces,
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
import { SkeletonViewer3D, SkeletonViewer3DHandle, CameraState, ViewerMode } from "./motionRef/SkeletonViewer3D";
import { MotionTimeline } from "./motionRef/MotionTimeline";
import { SMPLX22_BONES } from "./motionRef/smplx22Bones";

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
    resetSession,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);

  const skeletonRef = useRef<SkeletonViewer3DHandle | null>(null);

  // ── Motion data ────────────────────────────────────────────────────────────
  const [segments, setSegments] = useState<MotionRefSegment[]>(DEFAULT_SEGMENTS);
  const [manifest, setManifest] = useState<MotionRefManifest | null>(null);
  // SMPL-X mesh stream: flat float32 vertices for all frames + dims for slicing.
  const [meshData, setMeshData] = useState<{
    frames: Float32Array;
    vertexCount: number;
    frameCount: number;
  } | null>(null);
  const [jointsData, setJointsData] = useState<{
    frames: number[][][];
    jointCount: number;
    frameCount: number;
    bones: [number, number][];
  } | null>(null);
  const [displayMode, setDisplayMode] = useState<ViewerMode>("mesh");

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

  const totalFrames =
    meshData?.frameCount ?? jointsData?.frameCount ?? manifest?.frameCount ?? 0;

  // ── Load saved motions on open ─────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    apiMotionRefList().then(setMotions).catch(() => {});
  }, [open]);

  // ── Playback engine ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || totalFrames === 0) {
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
      const clamped = Math.floor(nextHead) % totalFrames;
      setFrameIndex(clamped);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, totalFrames]);

  // Push the current frame into the viewer (mesh or skeleton).
  useEffect(() => {
    if (displayMode === "mesh" && meshData) {
      const stride = meshData.vertexCount * 3;
      const start = frameIndex * stride;
      if (start + stride > meshData.frames.length) return;
      skeletonRef.current?.setFrame(meshData.frames.subarray(start, start + stride));
      return;
    }
    if (displayMode === "bones" && jointsData) {
      const frame = jointsData.frames[frameIndex];
      if (!frame) return;
      const flat = new Float32Array(jointsData.jointCount * 3);
      for (let j = 0; j < jointsData.jointCount; j++) {
        flat[j * 3] = frame[j][0];
        flat[j * 3 + 1] = frame[j][1];
        flat[j * 3 + 2] = frame[j][2];
      }
      skeletonRef.current?.setJointFrame(flat);
    }
  }, [frameIndex, meshData, jointsData, displayMode]);

  useEffect(() => {
    if (!open) {
      setPlaying(false);
      setFrameIndex(0);
      // Hard-reset the job session so a finished/stale loading window does not
      // reappear when the modal is reopened (the hook instance persists).
      resetSession();
    }
  }, [open, resetSession]);

  // Fetch the SMPL-X mesh stream for a motion, push faces into the viewer, and
  // return the decoded frame buffer (flat float32 vertices for all frames).
  async function loadMeshForMotion(
    motionKey: string,
    vertexCount: number,
  ): Promise<{ frames: Float32Array; vertexCount: number; frameCount: number }> {
    // Static faces → index buffer (once).
    const facesBuf = await apiMotionRefMeshFaces(motionKey);
    const facesText = await decompressGzipToText(facesBuf);
    const faces: number[][] = JSON.parse(facesText);
    const idx = new Uint32Array(faces.length * 3);
    for (let i = 0; i < faces.length; i++) {
      idx[i * 3] = faces[i][0];
      idx[i * 3 + 1] = faces[i][1];
      idx[i * 3 + 2] = faces[i][2];
    }
    skeletonRef.current?.setFaces(idx);

    // float16 [T,V,3] vertex stream → Float32Array.
    const meshBuf = await apiMotionRefMesh(motionKey);
    const bytes = await decompressGzipToBytes(meshBuf);
    const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    const frames = new Float32Array(u16.length);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < u16.length; i++) {
      const v = halfToFloat(u16[i]);
      frames[i] = v;
      if (i % 3 === 1) {
        if (v < minY) minY = v;
        if (v > maxY) maxY = v;
      }
    }
    // Fix the ground + camera framing once for the whole motion (stable, no bobbing).
    if (Number.isFinite(minY) && Number.isFinite(maxY)) {
      skeletonRef.current?.setFraming(minY, (minY + maxY) / 2);
    }

    const stride = vertexCount * 3;
    const frameCount = stride > 0 ? Math.floor(frames.length / stride) : 0;
    return { frames, vertexCount, frameCount };
  }

  function resolveBones(
    bones: number[][] | undefined,
    jointCount: number,
  ): [number, number][] {
    if (bones && bones.length > 0) {
      return bones.map((b) => [b[0], b[1]] as [number, number]);
    }
    if (jointCount === 22) return SMPLX22_BONES;
    return SMPLX22_BONES;
  }

  async function loadJointsForMotion(
    motionKey: string,
    mf: Pick<MotionRefManifest, "jointCount" | "frameCount" | "bones">,
  ): Promise<{
    frames: number[][][];
    jointCount: number;
    frameCount: number;
    bones: [number, number][];
  }> {
    const jointsBuf = await apiMotionRefJoints(motionKey);
    const jointsText = await decompressGzipToText(jointsBuf);
    const frames = JSON.parse(jointsText) as number[][][];
    const jointCount = mf.jointCount || (frames[0]?.length ?? 0);
    const bones = resolveBones(mf.bones, jointCount);
    skeletonRef.current?.setBonePairs(bones);
    skeletonRef.current?.setMode("bones");

    let minY = Infinity;
    let maxY = -Infinity;
    for (const frame of frames) {
      for (const joint of frame) {
        const y = joint[1];
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (Number.isFinite(minY) && Number.isFinite(maxY)) {
      skeletonRef.current?.setFraming(minY, (minY + maxY) / 2);
    }

    const frameCount = frames.length || mf.frameCount;
    return { frames, jointCount, frameCount, bones };
  }

  async function loadMotionDisplay(
    mf: MotionRefManifest,
    logPrefix: string,
  ): Promise<{ frameCount: number; mode: ViewerMode }> {
    if (mf.hasMesh && (mf.vertexCount ?? 0) > 0) {
      pushLog(`${logPrefix} mesh…`);
      const md = await loadMeshForMotion(mf.motionKey, mf.vertexCount ?? 0);
      setMeshData(md);
      setJointsData(null);
      setDisplayMode("mesh");
      skeletonRef.current?.setMode("mesh");
      return { frameCount: md.frameCount, mode: "mesh" };
    }
    pushLog(`${logPrefix} skeleton (no mesh)…`);
    const jd = await loadJointsForMotion(mf.motionKey, mf);
    setJointsData(jd);
    setMeshData(null);
    setDisplayMode("bones");
    return { frameCount: jd.frameCount, mode: "bones" };
  }

  // ── Generation (fresh — no starting pose conditioning) ────────────────────
  async function runGenerate() {
    if (!segments.some((s) => s.text.trim())) {
      showError({ message: "Enter at least one motion prompt before generating." });
      return;
    }
    setPlaying(false);
    setManifest(null);
    setMeshData(null);
    setJointsData(null);
    setDisplayMode("mesh");
    setFrameIndex(0);
    skeletonRef.current?.resetAll();

    beginSession({ title: "Generating motion (KiMoD)", clearLog: true });
    await Promise.resolve();
    pushLog("Starting KiMoD worker (model loads on first run)…");

    try {
      const done = await runMotionRefGenerateWsJob({
        motionName: segments[0].text.trim().slice(0, 40) || "motion",
        segments: segments.filter((s) => s.text.trim()),
        onLogLine: (line) => pushLog(line),
      });

      if (!done.ok || !done.result) {
        throw new Error(done.error || "Generation returned no result.");
      }

      const mf = done.result;
      setManifest(mf);

      const { frameCount, mode } = await loadMotionDisplay(mf, "Loading");
      setFrameIndex(0);
      pushLog(
        mode === "mesh"
          ? `Ready — ${frameCount} frames @ ${mf.fps} fps (mesh).`
          : `Ready — ${frameCount} frames @ ${mf.fps} fps (skeleton preview).`,
      );
      endSession();

      const newEntry: MotionRefListItem = {
        motionKey: mf.motionKey,
        fps: mf.fps,
        frameCount,
        jointCount: mf.jointCount,
        hasMesh: mf.hasMesh ?? false,
        vertexCount: mf.vertexCount,
        faceCount: mf.faceCount,
        bones: mf.bones,
        displayMode: mf.displayMode ?? (mode === "mesh" ? "mesh" : "skeleton"),
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
    setManifest({
      motionKey: item.motionKey,
      fps: item.fps,
      frameCount: item.frameCount,
      jointCount: item.jointCount,
      hasMesh: item.hasMesh,
      vertexCount: item.vertexCount,
      faceCount: item.faceCount,
      bones: item.bones,
      displayMode: item.displayMode,
      segments: item.segments ?? [],
    });
    beginSession({ title: "Loading motion…", clearLog: false });
    await Promise.resolve();
    try {
      const { frameCount, mode } = await loadMotionDisplay(
        {
          motionKey: item.motionKey,
          fps: item.fps,
          frameCount: item.frameCount,
          jointCount: item.jointCount,
          hasMesh: item.hasMesh,
          vertexCount: item.vertexCount,
          faceCount: item.faceCount,
          bones: item.bones,
          displayMode: item.displayMode,
          segments: item.segments ?? [],
        },
        "Loading",
      );
      setFrameIndex(0);
      pushLog(
        mode === "mesh"
          ? `Loaded — ${frameCount} frames @ ${item.fps} fps (mesh).`
          : `Loaded — ${frameCount} frames @ ${item.fps} fps (skeleton preview).`,
      );
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
        setMeshData(null);
        setJointsData(null);
        setDisplayMode("mesh");
        setFrameIndex(0);
        skeletonRef.current?.resetAll();
      }
    } catch {
      showError({ message: "Could not delete motion." });
    }
  }

  // ── Save shot → unified keypoint pose gallery ─────────────────────────────
  // Captures a WebGL screenshot of the live viewer (puppet pose or the current
  // playback frame) and runs SDpose/ControlNet on it — no server-side render,
  // so the heavy KiMoD worker is never involved in the shot path. When a motion
  // is loaded, the screenshot is also persisted as the gallery thumbnail.
  async function saveShot() {
    const dataUrl = skeletonRef.current?.captureFrame();
    if (!dataUrl) {
      showError({ message: "Could not capture the viewer. Try again." });
      return;
    }
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], "motion_shot.png", { type: "image/png" });

    beginSession({ title: "Saving shot", clearLog: false });
    await Promise.resolve();
    pushLog("Capturing viewer…");
    try {
      // Persist the screenshot as the motion thumbnail (pure file write, no worker).
      if (manifest) {
        try {
          const { shotRelPath } = await apiMotionRefSaveShotImage({
            motionKey: manifest.motionKey,
            pngBase64: dataUrl,
            shotName: `shot_f${frameIndex}_${Date.now()}`,
          });
          setMotions((prev) =>
            prev.map((m) =>
              m.motionKey === manifest.motionKey
                ? { ...m, thumbnailRelPath: shotRelPath }
                : m
            )
          );
        } catch {
          /* thumbnail is best-effort — don't fail the shot over it */
        }
      }

      pushLog("Uploading capture…");
      const { relPath } = await apiUploadStaging({ charKey, file });
      const screenBbox = skeletonRef.current?.getFigureScreenBbox();
      pushLog("Running SDpose keypoint detection…");
      const done = await runReferenceMakeKeypointWsJob({
        imageRelPath: relPath,
        ...(screenBbox
          ? {
              cropBox: {
                x: screenBbox.x,
                y: screenBbox.y,
                width: screenBbox.width,
                height: screenBbox.height,
              },
              imageWidth: screenBbox.imageWidth,
              imageHeight: screenBbox.imageHeight,
            }
          : {}),
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
      onClick={() => {
        if (motionCtxMenu) { setMotionCtxMenu(null); return; }
        onClose();
      }}
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
            <span style={{ fontSize: 14 }}>Motion Ref Gen</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "transparent", border: "none", color: "#888", cursor: "pointer", fontSize: 18 }}
          >
            ×
          </button>
        </div>

        {/* 3D viewer (resizable, fills width on open) */}
        <div style={{ padding: 12, borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <SkeletonViewer3D
            ref={skeletonRef}
            height={320}
            onCameraChange={(s) => setCameraState(s)}
          />
          <div style={{ fontSize: 10, color: "#555", marginTop: 4 }}>
            {displayMode === "mesh" ? "Mesh preview" : "Skeleton preview"}
            {" · "}Drag to orbit · Scroll to zoom · Drag corner to resize
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

        {/* Motion segments */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <MotionTimeline segments={segments} onChange={setSegments} disabled={busy} />
        </div>

        {/* Actions: Generate · Reset · Save Shot (one row) */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px", flexWrap: "wrap", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <button
            type="button" onClick={() => void runGenerate()} disabled={busy}
            title="Generate a fresh KiMoD motion sequence from the text segments"
            style={actionBtn}
          >
            Generate
          </button>
          <button
            type="button" onClick={() => skeletonRef.current?.resetAll()} disabled={busy}
            title="Reset the camera to defaults" style={actionBtn}
          >
            Reset
          </button>
          <button
            type="button" onClick={() => void saveShot()} disabled={busy}
            title="Capture the viewer → SDpose keypoints → pose gallery"
            style={{ ...actionBtn, background: "rgba(255,209,102,0.15)" }}
          >
            {manifest ? `Save Shot  (f${frameIndex} · Az ${cameraState.azimuth.toFixed(0)}°)` : "Save Shot"}
          </button>
        </div>

        {/* Animations gallery */}
        <div style={{ padding: "10px 16px" }}>
          <div style={{ fontSize: 11, color: "#aaa", marginBottom: 8 }}>
            Animations
          </div>
          {motions.length === 0 ? (
            <div style={{ fontSize: 12, color: "#555", padding: "12px 0" }}>
              No saved animations — generate one above.
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
          onClick={(e) => e.stopPropagation()}
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

async function decompressGzipToBytes(buf: ArrayBuffer): Promise<Uint8Array> {
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
    return out;
  }
  return new Uint8Array(buf);
}

async function decompressGzipToText(buf: ArrayBuffer): Promise<string> {
  return new TextDecoder().decode(await decompressGzipToBytes(buf));
}

/** Decode an IEEE-754 half-precision (float16) bit pattern to a JS number. */
function halfToFloat(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7c00) >> 10;
  const frac = h & 0x03ff;
  let val: number;
  if (exp === 0) {
    val = frac * Math.pow(2, -24);
  } else if (exp === 0x1f) {
    val = frac ? NaN : Infinity;
  } else {
    val = (1 + frac / 1024) * Math.pow(2, exp - 15);
  }
  return sign ? -val : val;
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
