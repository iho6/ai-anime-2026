"use client";

import React, {
  useCallback,
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
  apiMotionRefShotsLayout,
  apiMotionRefShotSave,
  apiMotionRefShotDelete,
  apiMotionRefShotFolderCreate,
  apiMotionRefShotFolderRename,
  apiMotionRefShotFolderDelete,
  apiMotionRefCameraTrajectoryGet,
  apiMotionRefCameraTrajectorySave,
  apiMotionRefCameraTrajectoryReplace,
  apiMotionRefCameraTrajectoryDelete,
  apiMotionRefCameraKeyframePatch,
  apiMotionRefPlaybackRangeSave,
  apiMotionRefV2PoseSeqStart,
  apiMotionRefV2PoseSeqFrame,
  apiMotionRefDiagShotsStart,
  apiMotionRefDiagShotsFrame,
  apiUploadStaging,
  MotionRefManifest,
  MotionRefListItem,
  MotionRefSegment,
  MotionRefShot,
  CameraKeyframe,
  MotionShotsLayout,
  V2PoseSeqSampleFps,
  V2PoseSeqFrameCapture,
  assetUrlFromRelPath,
  type SequencePreviewAspect,
  runMotionRefGenerateWsJob,
  runMotionRefSkinWsJob,
  runMotionRefShotAddToPoseWsJob,
  runReferenceMakeKeypointVideoWsJob,
  PoseReference,
  type KeypointVideoReference,
  MOTION_REF_DEFAULT_PROMPT_ADHERENCE,
  MOTION_REF_MAX_SEGMENT_DURATION_SEC,
} from "../lib/api";
import { useJobRunSession } from "../hooks/useJobRunSession";
import type { SharedLogStreamHandle } from "./SharedLogStream";
import { ConnectedJobRunModal } from "./ConnectedJobRunModal";
import { useAppError } from "./ErrorProvider";
import { PauseBarsIcon, SquareIconButton, TimelinePlayIcon, TriangleIcon } from "./IconPrimitives";
import { SkeletonViewer3D, SkeletonViewer3DHandle, CameraState, ViewerMode } from "./motionRef/SkeletonViewer3D";
import { MotionTimeline } from "./motionRef/MotionTimeline";
import { PromptAdherenceKnob } from "./motionRef/PromptAdherenceKnob";
import { MotionShotGallery } from "./motionRef/MotionShotGallery";
import { MotionPlaybackScrubber } from "./motionRef/MotionPlaybackScrubber";
import { CameraKeyframeContextMenu } from "./motionRef/CameraKeyframeContextMenu";
import { SEQUENCE_PREVIEW_ASPECT_OPTIONS } from "../lib/sequenceAspect";
import { CaptureAspectButton } from "./motionRef/captureAspectButton";
import { SMPLX22_BONES } from "./motionRef/smplx22Bones";
import {
  MOTION_REF_ACCENT,
  MOTION_REF_ACCENT_BORDER,
  MOTION_REF_ACCENT_BG,
  MOTION_REF_ACCENT_BTN_BG,
} from "./motionRef/theme";
import { interpolateWorldPoseAtFrame, DEFAULT_BLEND_EASE } from "./motionRef/cameraTrajectory";
import { ExportFpsDialog } from "./ExportFpsDialog";
import {
  apiEncodeFramesVideoToStaging,
  apiExportFramesVideo,
  dataUrlToStagingFile,
  sanitizeDownloadBaseName,
} from "../lib/downloadVideo";
import { isEditableTarget } from "../lib/nativeClipboardShortcuts";

const DEFAULT_SEGMENTS: MotionRefSegment[] = [
  { text: "A person is ", duration: 3.0 },
];

const TRAJECTORY_UNDO_CAP = 50;

function cloneKeyframes(kfs: CameraKeyframe[]): CameraKeyframe[] {
  return kfs.map((k) => ({ ...k }));
}

function encodeFpsFromSample(
  sampleFps: V2PoseSeqSampleFps,
  sourceFps: number
): number {
  if (sampleFps === "source") {
    return Math.max(1, Math.min(120, Math.round(sourceFps) || 24));
  }
  return sampleFps;
}

export function MotionRefGenModal(props: {
  open: boolean;
  charKey: string;
  /** Return to Add Reference Image modal. */
  onBack?: () => void;
  onClose: () => void;
  /** Called each time a keypoint is saved — adds to the unified pose gallery. */
  onKeypointsMade?: (ref: PoseReference) => void;
  /** Called when a video keypoint sequence row is saved to the reference library. */
  onKeypointVideoMade?: (ref: KeypointVideoReference) => void;
}) {
  const { open, charKey, onBack, onClose, onKeypointsMade, onKeypointVideoMade } = props;
  const { showError, askText, confirmAction } = useAppError();

  const logRef = useRef<SharedLogStreamHandle | null>(null);
  const {
    running: busy,
    beginSession,
    endSession,
    failSession,
    pushLog,
    onJobLogLine,
    resetSession,
    setRunningStatus,
    modalProps: jobModalProps,
  } = useJobRunSession(logRef);

  const skeletonRef = useRef<SkeletonViewer3DHandle | null>(null);

  // ── Motion data ────────────────────────────────────────────────────────────
  const [segments, setSegments] = useState<MotionRefSegment[]>(DEFAULT_SEGMENTS);
  const [promptAdherence, setPromptAdherence] = useState(MOTION_REF_DEFAULT_PROMPT_ADHERENCE);
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

  // ── In-place preview ───────────────────────────────────────────────────────
  // Viewer-only: strips per-frame horizontal root translation so the figure
  // stays centered during playback. Does not modify stored motion files.
  const [inPlace, setInPlace] = useState(false);
  const inPlaceRef = useRef(false);
  const [trajectoryEnabled, setTrajectoryEnabled] = useState(true);
  const trajectoryEnabledRef = useRef(true);
  // Show the crop-frame overlay (the square fed to SDPose) in the viewer.
  const [showCropFrame, setShowCropFrame] = useState(true);
  const [showOutputFrame, setShowOutputFrame] = useState(true);
  const [captureAspect, setCaptureAspect] = useState<SequencePreviewAspect>("16:9");
  // Root XZ per frame for mesh mode: Float32Array [x0,z0, x1,z1, ...].
  // Fetched from joints alongside the mesh; used to lock hips horizontally.
  const rootXZRef = useRef<Float32Array | null>(null);
  useEffect(() => { inPlaceRef.current = inPlace; }, [inPlace]);
  useEffect(() => { trajectoryEnabledRef.current = trajectoryEnabled; }, [trajectoryEnabled]);

  // ── Motion gallery (persisted motions) ────────────────────────────────────
  const [motions, setMotions] = useState<MotionRefListItem[]>([]);
  const [motionCtxMenu, setMotionCtxMenu] = useState<{
    motionKey: string;
    x: number;
    y: number;
  } | null>(null);
  const [cameraCtxMenu, setCameraCtxMenu] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [cameraKeyframes, setCameraKeyframes] = useState<CameraKeyframe[]>([]);
  const cameraKeyframesRef = useRef(cameraKeyframes);
  cameraKeyframesRef.current = cameraKeyframes;
  const trajectoryUndoRef = useRef<CameraKeyframe[][]>([]);
  const trajectoryRedoRef = useRef<CameraKeyframe[][]>([]);
  const [playbackStart, setPlaybackStart] = useState(0);
  const [playbackEnd, setPlaybackEnd] = useState(0);
  const playbackSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userOrbitingRef = useRef(false);
  const userCameraOverrideRef = useRef(false);
  const viewerCenterYRef = useRef(0.9);

  // ── Shots gallery ─────────────────────────────────────────────────────────
  const [shotsLayout, setShotsLayout] = useState<MotionShotsLayout>({
    folders: [],
    rootOrder: [],
    folderOrder: {},
    items: [],
  });
  const [selectedShotIds, setSelectedShotIds] = useState<Set<string>>(new Set());

  const loadShotsLayout = useCallback(async () => {
    try {
      const layout = await apiMotionRefShotsLayout();
      setShotsLayout(layout);
    } catch {
      /* ignore */
    }
  }, []);

  const [v2poseDialog, setV2poseDialog] = useState<{
    motionKey: string;
    label: string;
    sampleFps: V2PoseSeqSampleFps;
    folderName: string;
    useVideoKeypointService: boolean;
    noSdpose: boolean;
  } | null>(null);
  const [fpsExportPending, setFpsExportPending] = useState<{
    motionKey: string;
    item: MotionRefListItem;
    label: string;
  } | null>(null);

  // ── Playback ───────────────────────────────────────────────────────────────
  const [frameIndex, setFrameIndex] = useState(0);
  const frameIndexRef = useRef(frameIndex);
  frameIndexRef.current = frameIndex;
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);
  const anchorRef = useRef<{ wall: number; head: number; fps: number } | null>(null);

  // ── Camera state ───────────────────────────────────────────────────────────
  const [cameraState, setCameraState] = useState<CameraState>({
    azimuth: 20,
    elevation: 15,
    distance: 3,
    slideX: 0,
    slideY: 0,
  });

  const totalFrames =
    meshData?.frameCount ?? jointsData?.frameCount ?? manifest?.frameCount ?? 0;

  useEffect(() => {
    if (totalFrames <= 0) return;
    const max = Math.max(0, totalFrames - 1);
    setPlaybackEnd((e) => Math.min(Math.max(e, 1), max));
    setPlaybackStart((s) => Math.min(s, max));
  }, [totalFrames]);

  function repushCurrentFrame() {
    if (displayMode === "mesh" && meshData) {
      pushMeshFrame(meshData, frameIndex);
      return;
    }
    if (displayMode === "bones" && jointsData) {
      const frame = jointsData.frames[frameIndex];
      if (!frame) return;
      const rootX = inPlace ? (frame[0]?.[0] ?? 0) : 0;
      const rootZ = inPlace ? (frame[0]?.[2] ?? 0) : 0;
      const flat = new Float32Array(jointsData.jointCount * 3);
      for (let j = 0; j < jointsData.jointCount; j++) {
        flat[j * 3] = frame[j][0] - rootX;
        flat[j * 3 + 1] = frame[j][1];
        flat[j * 3 + 2] = frame[j][2] - rootZ;
      }
      skeletonRef.current?.setJointFrame(flat);
    }
  }

  function applyTrajectoryAtFrame(
    frame: number,
    keyframes: CameraKeyframe[] = cameraKeyframes,
    opts?: { forCapture?: boolean; forceApply?: boolean },
  ) {
    if (keyframes.length === 0) {
      return;
    }
    if (!opts?.forceApply && !trajectoryEnabledRef.current) {
      return;
    }
    if (
      !opts?.forCapture &&
      !opts?.forceApply &&
      (userOrbitingRef.current || userCameraOverrideRef.current)
    ) {
      return;
    }
    const centerY = skeletonRef.current?.getViewerCenterY() ?? viewerCenterYRef.current;
    const pose = interpolateWorldPoseAtFrame(frame, keyframes, centerY);
    if (!pose) return;
    skeletonRef.current?.setCameraWorldPose(pose.position, pose.target);
    const cam = skeletonRef.current?.getCameraState();
    if (cam) setCameraState(cam);
  }

  const clearTrajectoryHistory = useCallback(() => {
    trajectoryUndoRef.current = [];
    trajectoryRedoRef.current = [];
  }, []);

  const commitTrajectory = useCallback(() => {
    trajectoryUndoRef.current.push(cloneKeyframes(cameraKeyframesRef.current));
    if (trajectoryUndoRef.current.length > TRAJECTORY_UNDO_CAP) {
      trajectoryUndoRef.current.shift();
    }
    trajectoryRedoRef.current = [];
  }, []);

  const applyTrajectorySnapshot = useCallback(
    async (next: CameraKeyframe[]) => {
      if (!manifest?.motionKey) return;
      const prev = cloneKeyframes(cameraKeyframesRef.current);
      setCameraKeyframes(next);
      try {
        const data = await apiMotionRefCameraTrajectoryReplace(manifest.motionKey, next);
        const kfs = data.keyframes ?? [];
        setCameraKeyframes(kfs);
        applyTrajectoryAtFrame(frameIndexRef.current, kfs, { forCapture: false });
      } catch {
        setCameraKeyframes(prev);
        showError({ message: "Could not restore camera trajectory." });
      }
    },
    [manifest?.motionKey, showError]
  );

  const undoTrajectory = useCallback(async () => {
    const snap = trajectoryUndoRef.current.pop();
    if (!snap || !manifest?.motionKey) return;
    trajectoryRedoRef.current.push(cloneKeyframes(cameraKeyframesRef.current));
    if (trajectoryRedoRef.current.length > TRAJECTORY_UNDO_CAP) {
      trajectoryRedoRef.current.shift();
    }
    await applyTrajectorySnapshot(snap);
  }, [manifest?.motionKey, applyTrajectorySnapshot]);

  const redoTrajectory = useCallback(async () => {
    const snap = trajectoryRedoRef.current.pop();
    if (!snap || !manifest?.motionKey) return;
    trajectoryUndoRef.current.push(cloneKeyframes(cameraKeyframesRef.current));
    if (trajectoryUndoRef.current.length > TRAJECTORY_UNDO_CAP) {
      trajectoryUndoRef.current.shift();
    }
    await applyTrajectorySnapshot(snap);
  }, [manifest?.motionKey, applyTrajectorySnapshot]);

  function handleResetCamera() {
    skeletonRef.current?.resetCamera();
    const cam = skeletonRef.current?.getCameraState();
    if (cam) setCameraState(cam);
    repushCurrentFrame();
  }

  function persistPlaybackRange(start: number, end: number) {
    if (!manifest?.motionKey) return;
    if (playbackSaveRef.current) clearTimeout(playbackSaveRef.current);
    playbackSaveRef.current = setTimeout(() => {
      apiMotionRefPlaybackRangeSave(manifest.motionKey, start, end).catch(() => {});
    }, 400);
  }

  function handlePlaybackRangeChange(start: number, end: number) {
    setPlaying(false);
    setPlaybackStart(start);
    setPlaybackEnd(end);
    setFrameIndex((f) => Math.min(Math.max(f, start), end));
    persistPlaybackRange(start, end);
  }

  function pushMeshFrame(
    md: { frames: Float32Array; vertexCount: number; frameCount: number },
    frameIdx: number,
  ) {
    const stride = md.vertexCount * 3;
    if (stride <= 0 || md.frames.length < stride) return;
    const maxFrame = Math.max(0, md.frameCount - 1);
    const fi = Math.min(Math.max(0, frameIdx), maxFrame);
    const start = fi * stride;
    if (start + stride > md.frames.length) return;
    skeletonRef.current?.setMode("mesh");

    const slice = md.frames.subarray(start, start + stride);
    const verts = new Float32Array(stride);
    verts.set(slice);
    if (inPlaceRef.current && rootXZRef.current && fi * 2 + 1 < rootXZRef.current.length) {
      const rx = rootXZRef.current[fi * 2];
      const rz = rootXZRef.current[fi * 2 + 1];
      for (let i = 0; i < stride; i += 3) {
        verts[i] -= rx;
        verts[i + 2] -= rz;
      }
    }
    skeletonRef.current?.setFrame(verts);
  }

  // ── Load saved motions on open ─────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    apiMotionRefList().then(setMotions).catch(() => {});
    void loadShotsLayout();
  }, [open, loadShotsLayout]);

  // ── Playback engine ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!playing || totalFrames === 0) {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      anchorRef.current = null;
      return;
    }
    const fps = manifest?.fps ?? 30;
    const start = playbackStart;
    const end = Math.min(playbackEnd, totalFrames - 1);
    const span = Math.max(1, end - start + 1);
    anchorRef.current = { wall: performance.now(), head: frameIndex, fps };
    const tick = () => {
      const a = anchorRef.current;
      if (!a) return;
      const elapsed = (performance.now() - a.wall) / 1000;
      const offset = Math.floor(a.head - start + elapsed * a.fps);
      const wrapped = ((offset % span) + span) % span;
      const clamped = start + wrapped;
      setFrameIndex(clamped);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, totalFrames, playbackStart, playbackEnd]);

  // Push the current frame into the viewer (mesh or skeleton).
  useEffect(() => {
    if (displayMode === "mesh" && meshData) {
      pushMeshFrame(meshData, frameIndex);
      return;
    }
    if (displayMode === "bones" && jointsData) {
      const frame = jointsData.frames[frameIndex];
      if (!frame) return;
      const rootX = inPlace ? (frame[0]?.[0] ?? 0) : 0;
      const rootZ = inPlace ? (frame[0]?.[2] ?? 0) : 0;
      const flat = new Float32Array(jointsData.jointCount * 3);
      for (let j = 0; j < jointsData.jointCount; j++) {
        flat[j * 3]     = frame[j][0] - rootX;
        flat[j * 3 + 1] = frame[j][1];          // Y unchanged
        flat[j * 3 + 2] = frame[j][2] - rootZ;
      }
      skeletonRef.current?.setJointFrame(flat);
    }
  // inPlace is consumed via inPlaceRef in pushMeshFrame, but is listed here so
  // the effect re-runs when the toggle changes, updating the current mesh frame.
  }, [frameIndex, meshData, jointsData, displayMode, inPlace]);

  // Apply camera trajectory during playback only.
  useEffect(() => {
    if (!playing) return;
    if (cameraKeyframes.length === 0 || !trajectoryEnabled) return;
    if (userCameraOverrideRef.current) return;
    applyTrajectoryAtFrame(frameIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, frameIndex, cameraKeyframes, trajectoryEnabled]);

  useEffect(() => {
    skeletonRef.current?.setGizmosVisible(!playing);
  }, [playing]);

  useEffect(() => {
    skeletonRef.current?.setCropOverlayVisible(showCropFrame);
  }, [showCropFrame, meshData, jointsData]);

  useEffect(() => {
    skeletonRef.current?.setOutputFrameOverlayVisible(showOutputFrame);
  }, [showOutputFrame, meshData, jointsData]);

  useEffect(() => {
    skeletonRef.current?.setCameraGizmos(
      cameraKeyframes,
      skeletonRef.current?.getViewerCenterY() ?? viewerCenterYRef.current,
    );
  }, [cameraKeyframes, meshData, jointsData]);

  useEffect(() => {
    if (!open) {
      setPlaying(false);
      setFrameIndex(0);
      clearTrajectoryHistory();
      // Hard-reset the job session so a finished/stale loading window does not
      // reappear when the modal is reopened (the hook instance persists).
      resetSession();
    }
  }, [open, resetSession, clearTrajectoryHistory]);

  useEffect(() => {
    clearTrajectoryHistory();
  }, [manifest?.motionKey, clearTrajectoryHistory]);

  useEffect(() => {
    if (!open || !manifest?.motionKey || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (isEditableTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        void undoTrajectory();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        void redoTrajectory();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, manifest?.motionKey, busy, undoTrajectory, redoTrajectory]);

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
    let maxFaceIndex = 0;
    for (let i = 0; i < faces.length; i++) {
      const a = faces[i][0];
      const b = faces[i][1];
      const c = faces[i][2];
      idx[i * 3] = a;
      idx[i * 3 + 1] = b;
      idx[i * 3 + 2] = c;
      maxFaceIndex = Math.max(maxFaceIndex, a, b, c);
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
      const centerY = (minY + maxY) / 2;
      viewerCenterYRef.current = centerY;
      skeletonRef.current?.setFraming(minY, centerY);
    }

    const vertsFromFaces = maxFaceIndex + 1;
    let resolvedVertexCount = vertexCount > 0 ? vertexCount : vertsFromFaces;
    if (vertsFromFaces > 0 && resolvedVertexCount !== vertsFromFaces) {
      console.warn(
        `Mesh vertex count mismatch for ${motionKey}: manifest=${resolvedVertexCount}, ` +
          `faces imply ${vertsFromFaces}. Using ${vertsFromFaces}.`,
      );
      resolvedVertexCount = vertsFromFaces;
    }

    const stride = resolvedVertexCount * 3;
    let frameCount = stride > 0 ? Math.floor(frames.length / stride) : 0;
    if (stride > 0 && frames.length % stride !== 0) {
      console.warn(
        `Mesh buffer length ${frames.length} is not a multiple of stride ${stride} ` +
          `for ${motionKey}; ignoring partial tail frame.`,
      );
      frameCount = Math.floor(frames.length / stride);
    }

    // Fetch joints in the background to extract per-frame root XZ for in-place preview.
    try {
      const jBuf = await apiMotionRefJoints(motionKey);
      const jText = await decompressGzipToText(jBuf);
      const jFrames = JSON.parse(jText) as number[][][];
      const rxz = new Float32Array(jFrames.length * 2);
      for (let i = 0; i < jFrames.length; i++) {
        rxz[i * 2]     = jFrames[i][0][0]; // hips X
        rxz[i * 2 + 1] = jFrames[i][0][2]; // hips Z
      }
      rootXZRef.current = rxz;
    } catch {
      rootXZRef.current = null;
    }

    return { frames, vertexCount: resolvedVertexCount, frameCount };
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
      const centerY = (minY + maxY) / 2;
      viewerCenterYRef.current = centerY;
      skeletonRef.current?.setFraming(minY, centerY);
    }

    const frameCount = frames.length || mf.frameCount;
    return { frames, jointCount, frameCount, bones };
  }

  async function loadMotionDisplay(
    mf: MotionRefManifest,
    logPrefix: string,
    initialFrame = 0,
  ): Promise<{ frameCount: number; mode: ViewerMode }> {
    if (mf.hasMesh && (mf.vertexCount ?? 0) > 0) {
      pushLog(`${logPrefix} mesh…`);
      const md = await loadMeshForMotion(mf.motionKey, mf.vertexCount ?? 0);
      setMeshData(md);
      setJointsData(null);
      setDisplayMode("mesh");
      pushMeshFrame(md, initialFrame);
      return { frameCount: md.frameCount, mode: "mesh" };
    }
    pushLog(`${logPrefix} no mesh — loading skeleton, then attempting auto-skin…`);
    const jd = await loadJointsForMotion(mf.motionKey, mf);
    setJointsData(jd);
    setMeshData(null);
    setDisplayMode("bones");

    try {
      const skinDone = await runMotionRefSkinWsJob(mf.motionKey, (line) => pushLog(line));
      if (skinDone.ok && skinDone.result?.hasMesh) {
        const { vertexCount } = skinDone.result;
        const md = await loadMeshForMotion(mf.motionKey, vertexCount);
        setMeshData(md);
        setJointsData(null);
        setDisplayMode("mesh");
        pushMeshFrame(md, initialFrame);
        setManifest((prev) =>
          prev ? { ...prev, hasMesh: true, vertexCount, displayMode: "mesh" } : prev,
        );
        return { frameCount: md.frameCount, mode: "mesh" };
      }
    } catch {
      // skinning failed — stay on skeleton, no error surfaced to user
    }

    pushBonesFrame(jd, initialFrame);
    return { frameCount: jd.frameCount, mode: "bones" };
  }

  function pushBonesFrame(
    jd: { frames: number[][][]; jointCount: number },
    frameIdx: number,
  ) {
    const frame = jd.frames[frameIdx];
    if (!frame) return;
    const rootX = inPlaceRef.current ? (frame[0]?.[0] ?? 0) : 0;
    const rootZ = inPlaceRef.current ? (frame[0]?.[2] ?? 0) : 0;
    const flat = new Float32Array(jd.jointCount * 3);
    for (let j = 0; j < jd.jointCount; j++) {
      flat[j * 3] = frame[j][0] - rootX;
      flat[j * 3 + 1] = frame[j][1];
      flat[j * 3 + 2] = frame[j][2] - rootZ;
    }
    skeletonRef.current?.setJointFrame(flat);
  }

  // ── Generation (fresh — no starting pose conditioning) ────────────────────
  async function runGenerate() {
    if (!segments.some((s) => s.text.trim())) {
      showError({ message: "Enter at least one motion prompt before generating." });
      return;
    }
    const activeSegments = segments.filter((s) => s.text.trim());
    if (activeSegments.some((s) => s.duration > MOTION_REF_MAX_SEGMENT_DURATION_SEC)) {
      showError({
        message: `Each segment must be at most ${MOTION_REF_MAX_SEGMENT_DURATION_SEC} seconds (Kimodo limit).`,
      });
      return;
    }
    setPlaying(false);
    setManifest(null);
    setMeshData(null);
    setJointsData(null);
    setDisplayMode("mesh");
    setFrameIndex(0);
    setCameraKeyframes([]);
    clearTrajectoryHistory();
    setPlaybackStart(0);
    setPlaybackEnd(0);
    setTrajectoryEnabled(true);
    skeletonRef.current?.resetAll();

    beginSession({ title: "Generating motion (KiMoD)", clearLog: true });
    await Promise.resolve();
    pushLog("Starting KiMoD worker (model loads on first run)…");

    try {
      const done = await runMotionRefGenerateWsJob({
        motionName: segments[0].text.trim().slice(0, 40) || "motion",
        segments: activeSegments,
        promptAdherence,
        onLogLine: (line) => pushLog(line),
      });

      if (!done.ok || !done.result) {
        throw new Error(done.error || "Generation returned no result.");
      }

      const mf = done.result;
      setManifest(mf);

      const { frameCount, mode } = await loadMotionDisplay(mf, "Loading");
      setFrameIndex(0);
      await loadCameraTrajectory(mf.motionKey, frameCount);
      setTrajectoryEnabled(true);
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
  async function loadMotion(
    item: MotionRefListItem,
    opts?: {
      initialFrame?: number;
      camera?: Partial<CameraState> & Pick<CameraState, "azimuth" | "elevation">;
      quiet?: boolean;
    },
  ): Promise<{
    frameCount: number;
    playbackStart: number;
    playbackEnd: number;
    fps: number;
    keyframes: CameraKeyframe[];
  } | void> {
    if (busy && !opts?.quiet) return;
    setPlaying(false);
    rootXZRef.current = null;
    setTrajectoryEnabled(true);
    setCameraKeyframes([]);
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
    if (!opts?.quiet) {
      beginSession({ title: "Loading motion…", clearLog: false });
      await Promise.resolve();
    }
    try {
      const fi = opts?.initialFrame ?? 0;
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
        fi,
      );
      const clamped = Math.min(Math.max(0, fi), Math.max(0, frameCount - 1));
      setFrameIndex(clamped);
      const trim = await loadCameraTrajectory(item.motionKey, frameCount);
      if (opts?.camera) {
        skeletonRef.current?.setCameraState(opts.camera);
        setCameraState((prev) => ({ ...prev, ...opts.camera }));
      }
      if (!opts?.quiet) {
        pushLog(
          mode === "mesh"
            ? `Loaded — ${frameCount} frames @ ${item.fps} fps (mesh).`
            : `Loaded — ${frameCount} frames @ ${item.fps} fps (skeleton preview).`,
        );
        endSession();
      }
      return {
        frameCount,
        playbackStart: trim.start,
        playbackEnd: trim.end,
        fps: item.fps,
        keyframes: trim.keyframes,
      };
    } catch (e) {
      if (opts?.quiet) throw e;
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
        setCameraKeyframes([]);
        setDisplayMode("mesh");
        setFrameIndex(0);
        skeletonRef.current?.resetAll();
      }
    } catch {
      showError({ message: "Could not delete motion." });
    }
  }

  async function loadCameraTrajectory(motionKey: string, frameCount?: number) {
    const max = Math.max(0, (frameCount ?? totalFrames) - 1);
    try {
      const data = await apiMotionRefCameraTrajectoryGet(motionKey);
      const keyframes = data.keyframes ?? [];
      setCameraKeyframes(keyframes);
      const pr = data.playbackRange;
      let start = 0;
      let end = max;
      if (pr && max > 0) {
        start = Math.max(0, Math.min(pr.startFrame, max));
        end = Math.max(start, Math.min(pr.endFrame, max));
      }
      setPlaybackStart(start);
      setPlaybackEnd(end);
      return { start, end, keyframes };
    } catch {
      setCameraKeyframes([]);
      setPlaybackStart(0);
      setPlaybackEnd(max);
      return { start: 0, end: max, keyframes: [] as CameraKeyframe[] };
    }
  }

  async function saveTrajectoryKeyframe() {
    if (!manifest) {
      showError({ message: "Load an animation before saving a camera pose." });
      return;
    }
    const bbox = skeletonRef.current?.getFigureScreenBbox();
    if (!bbox) {
      showError({
        message:
          "Figure not visible in frame — enable In place, reset camera, or adjust the view before adding a trajectory keyframe.",
      });
      return;
    }
    const cam = skeletonRef.current?.getCameraState();
    if (!cam) return;
    const pose = skeletonRef.current?.getCameraWorldPose();
    if (!pose) return;
    commitTrajectory();
    try {
      const data = await apiMotionRefCameraTrajectorySave(manifest.motionKey, {
        frameIndex,
        azimuth: cam.azimuth,
        elevation: cam.elevation,
        distance: cam.distance,
        slideX: cam.slideX,
        slideY: cam.slideY,
        cameraPosition: pose.position,
        lookAtTarget: pose.target,
      });
      setCameraKeyframes(data.keyframes ?? []);
    } catch {
      showError({ message: "Could not save camera trajectory keyframe." });
    }
  }

  async function deleteCameraKeyframe(keyframeId: string) {
    if (!manifest) return;
    setCameraCtxMenu(null);
    commitTrajectory();
    try {
      const data = await apiMotionRefCameraTrajectoryDelete(manifest.motionKey, keyframeId);
      setCameraKeyframes(data.keyframes ?? []);
    } catch {
      showError({ message: "Could not delete camera pose." });
    }
  }

  async function saveCameraKeyframePatch(
    keyframeId: string,
    patch: { holdFrames: number; blendEase: number },
  ) {
    if (!manifest) return;
    const existing = cameraKeyframes.find((k) => k.id === keyframeId);
    if (!existing) return;
    commitTrajectory();
    try {
      const data = await apiMotionRefCameraKeyframePatch(
        manifest.motionKey,
        keyframeId,
        patch,
        existing,
      );
      setCameraKeyframes(data.keyframes ?? []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not save camera keyframe.";
      showError({ message: msg });
    }
  }

  function maxHoldForKeyframe(keyframeId: string): number {
    const sorted = [...cameraKeyframes].sort((a, b) => a.frameIndex - b.frameIndex);
    const idx = sorted.findIndex((k) => k.id === keyframeId);
    if (idx < 0 || idx >= sorted.length - 1) return 999;
    return Math.max(0, sorted[idx + 1].frameIndex - sorted[idx].frameIndex - 1);
  }

  function jumpToCameraKeyframe(kf: CameraKeyframe) {
    setPlaying(false);
    const maxFrame = Math.max(0, totalFrames - 1);
    const f = Math.min(Math.max(0, kf.frameIndex), maxFrame);
    setFrameIndex(f);
    applyTrajectoryAtFrame(f, cameraKeyframes, { forceApply: true });
    userCameraOverrideRef.current = true;
  }

  async function saveShot() {
    if (!manifest) {
      showError({ message: "Load an animation before saving a shot." });
      return;
    }
    const dataUrl = skeletonRef.current?.captureFrame();
    if (!dataUrl) {
      showError({ message: "Could not capture the viewer. Try again." });
      return;
    }
    const screenBbox = skeletonRef.current?.getFigureScreenBbox();
    if (!screenBbox) {
      showError({
        message:
          "Figure not in frame — the shot will be saved, but SDPose will run on the full frame. Recenter the camera for a tight crop.",
      });
    }
    try {
      await apiMotionRefShotSave({
        motionKey: manifest.motionKey,
        pngBase64: dataUrl,
        frameIndex,
        azimuth: cameraState.azimuth,
        elevation: cameraState.elevation,
        distance: cameraState.distance,
        slideX: cameraState.slideX,
        slideY: cameraState.slideY,
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
      });
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
        /* thumbnail is best-effort */
      }
      await loadShotsLayout();
    } catch {
      showError({ message: "Could not save shot." });
    }
  }

  async function restoreShot(shot: MotionRefShot) {
    const motion = motions.find((m) => m.motionKey === shot.motionKey);
    if (!motion) {
      showError({ message: "The motion for this shot was deleted." });
      return;
    }
    setPlaying(false);
    const camera: Partial<CameraState> & Pick<CameraState, "azimuth" | "elevation"> = {
      azimuth: shot.azimuth,
      elevation: shot.elevation,
      ...(shot.distance != null ? { distance: shot.distance } : {}),
      ...(shot.slideX != null ? { slideX: shot.slideX } : {}),
      ...(shot.slideY != null ? { slideY: shot.slideY } : {}),
    };
    if (manifest?.motionKey === shot.motionKey) {
      const maxFrame = Math.max(0, totalFrames - 1);
      setFrameIndex(Math.min(shot.frameIndex, maxFrame));
      skeletonRef.current?.setCameraState(camera);
      setCameraState((prev) => ({ ...prev, ...camera }));
      return;
    }
    await loadMotion(motion, { initialFrame: shot.frameIndex, camera });
  }

  async function addShotsToPose(shots: MotionRefShot[]) {
    const pending = shots
      .filter((s) => !s.keypointId)
      .sort((a, b) => a.frameIndex - b.frameIndex);
    if (!pending.length) return;
    beginSession({ title: "Add to Pose", clearLog: false, runningStatus: `0/${pending.length} complete` });
    await Promise.resolve();
    try {
      let doneCount = 0;
      for (const shot of pending) {
        doneCount += 1;
        const status = `Add to Pose ${doneCount}/${pending.length}…`;
        setRunningStatus(status);
        pushLog(`Shot f${shot.frameIndex} (${doneCount}/${pending.length})…`);
        const done = await runMotionRefShotAddToPoseWsJob({
          shotId: shot.id,
          onLogLine: onJobLogLine,
        });
        if (!done.ok || !done.result?.item) {
          throw new Error(done.error || "Add to Pose failed.");
        }
        if (!done.result.skipped) {
          onKeypointsMade?.(done.result.item);
        }
      }
      await loadShotsLayout();
      pushLog("Done.");
      endSession();
    } catch (e) {
      failSession(e, "Could not add shot to pose ref.");
    }
  }

  async function deleteShot(shotId: string) {
    try {
      await apiMotionRefShotDelete(shotId);
      setSelectedShotIds((prev) => {
        const n = new Set(prev);
        n.delete(shotId);
        return n;
      });
      await loadShotsLayout();
    } catch {
      showError({ message: "Could not delete shot." });
    }
  }

  async function createShotFolder(parentFolderId: string | null, shotIds: string[]) {
    const ids = shotIds.length ? shotIds : [...selectedShotIds];
    if (!ids.length) return;
    const name = await askText({
      title: "New folder",
      message: "Name for this shots folder:",
      defaultValue: "Folder",
      confirmText: "Create",
    });
    if (!name?.trim()) return;
    try {
      await apiMotionRefShotFolderCreate(name.trim(), ids, parentFolderId);
      setSelectedShotIds(new Set());
      await loadShotsLayout();
    } catch {
      showError({ message: "Could not create folder." });
    }
  }

  async function renameShotFolder(folderId: string, currentName: string) {
    const name = await askText({
      title: "Rename folder",
      message: "Folder name:",
      defaultValue: currentName,
      confirmText: "Rename",
    });
    if (!name?.trim()) return;
    try {
      await apiMotionRefShotFolderRename(folderId, name.trim());
      await loadShotsLayout();
    } catch {
      showError({ message: "Could not rename folder." });
    }
  }

  async function deleteShotFolder(folderId: string) {
    const ok = await confirmAction({
      title: "Ungroup folder",
      message: "Dissolve this folder and move its contents to the parent level?",
      confirmText: "Ungroup",
    });
    if (!ok) return;
    try {
      await apiMotionRefShotFolderDelete(folderId);
      await loadShotsLayout();
    } catch {
      showError({ message: "Could not ungroup folder." });
    }
  }

  function computeV2PoseFrameList(
    start: number,
    end: number,
    sourceFps: number,
    sampleFps: V2PoseSeqSampleFps | number
  ): number[] {
    const out: number[] = [];
    if (end < start) return out;
    if (sampleFps === "source") {
      for (let f = start; f <= end; f++) out.push(f);
      return out;
    }
    const targetFps = typeof sampleFps === "number" ? sampleFps : sampleFps;
    const step = Math.max(1, Math.round(sourceFps / targetFps));
    for (let f = start; f <= end; f += step) out.push(f);
    return out;
  }

  async function waitViewerFrame() {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  async function captureMotionViewerFrames(
    motionKey: string,
    item: MotionRefListItem,
    sampleFps: V2PoseSeqSampleFps | number,
    opts: {
      mode: "video" | "v2pose";
      pushLog: (msg: string) => void;
      setRunningStatus: (msg: string) => void;
    }
  ): Promise<
    | { mode: "video"; dataUrls: string[] }
    | {
        mode: "v2pose";
        captures: V2PoseSeqFrameCapture[];
        skippedFrames: number[];
        clippedFrames: number[];
      }
  > {
    let start = playbackStart;
    let end = playbackEnd;
    let fps = manifest?.fps ?? item.fps ?? 30;
    let motionFrameCount = totalFrames;
    let captureKeyframes = cameraKeyframes;

    if (manifest?.motionKey !== motionKey) {
      opts.pushLog(`Loading ${motionKey}…`);
      const loaded = await loadMotion(item, { quiet: true });
      if (!loaded) throw new Error("Could not load motion.");
      start = loaded.playbackStart;
      end = loaded.playbackEnd;
      fps = loaded.fps;
      motionFrameCount = loaded.frameCount;
      captureKeyframes = loaded.keyframes;
    }

    end = Math.min(end, Math.max(0, motionFrameCount - 1));
    const frames = computeV2PoseFrameList(start, end, fps, sampleFps);
    if (!frames.length) {
      throw new Error("Trim range is empty — adjust in/out handles.");
    }
    const trajectoryCapture =
      trajectoryEnabledRef.current && captureKeyframes.length > 0;
    opts.pushLog(
      `Capturing ${frames.length} frames (trim f${start}–f${end}, ${String(sampleFps)} fps` +
        `${trajectoryCapture ? ", trajectory camera" : ", fixed camera"})…`
    );
    setPlaying(false);
    await waitViewerFrame();

    if (opts.mode === "video") {
      const dataUrls: string[] = [];
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        opts.setRunningStatus(`Capturing frame ${i + 1}/${frames.length}…`);
        setFrameIndex(f);
        await waitViewerFrame();
        applyTrajectoryAtFrame(f, captureKeyframes, { forCapture: true });
        await waitViewerFrame();
        const dataUrl = skeletonRef.current?.captureFrame();
        if (!dataUrl) throw new Error(`Capture failed at frame ${f}.`);
        dataUrls.push(dataUrl);
        opts.pushLog(`Captured f${f} (${i + 1}/${frames.length})`);
      }
      return { mode: "video", dataUrls };
    }

    const captures: V2PoseSeqFrameCapture[] = [];
    const skippedFrames: number[] = [];
    const clippedFrames: number[] = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      opts.setRunningStatus(`Capturing frame ${i + 1}/${frames.length}…`);
      setFrameIndex(f);
      // Direct sync: guarantee positionsRef and geometry are at frame f before
      // captureFrameAutoFit runs, independent of React 18 effect scheduling.
      if (displayMode === "mesh" && meshData) pushMeshFrame(meshData, f);
      await waitViewerFrame();
      applyTrajectoryAtFrame(f, captureKeyframes, { forCapture: true });
      await waitViewerFrame();
      const autoFit = skeletonRef.current?.captureFrameAutoFit();
      if (!autoFit) {
        skippedFrames.push(f);
        opts.pushLog(`Skipped f${f}: figure out of frame.`);
        continue;
      }
      const { dataUrl, screenBbox } = autoFit;
      const edgeClipped =
        screenBbox.x <= 0 ||
        screenBbox.y <= 0 ||
        screenBbox.x + screenBbox.width >= screenBbox.imageWidth ||
        screenBbox.y + screenBbox.height >= screenBbox.imageHeight;
      if (edgeClipped) clippedFrames.push(f);
      const cam = skeletonRef.current?.getCameraState() ?? cameraState;
      captures.push({
        frameIndex: f,
        pngBase64: dataUrl,
        azimuth: cam.azimuth,
        elevation: cam.elevation,
        cropBox: {
          x: screenBbox.x,
          y: screenBbox.y,
          width: screenBbox.width,
          height: screenBbox.height,
        },
        imageWidth: screenBbox.imageWidth,
        imageHeight: screenBbox.imageHeight,
      });
      opts.pushLog(`Captured f${f} (${i + 1}/${frames.length})`);
    }
    return { mode: "v2pose", captures, skippedFrames, clippedFrames };
  }

  async function uploadCapturedFramesToStaging(dataUrls: string[]): Promise<string[]> {
    pushLog(`Uploading ${dataUrls.length} frames…`);
    const relPaths: string[] = [];
    for (let i = 0; i < dataUrls.length; i++) {
      setRunningStatus(`Uploading frame ${i + 1}/${dataUrls.length}…`);
      const file = await dataUrlToStagingFile(dataUrls[i], i);
      const { relPath } = await apiUploadStaging({ charKey, file });
      relPaths.push(relPath);
    }
    return relPaths;
  }

  async function uploadCapturedFramesAndEncode(params: {
    dataUrls: string[];
    fps: number;
    filenameBase: string;
  }): Promise<{ videoRelPath: string; relPaths: string[] }> {
    const { dataUrls, fps, filenameBase } = params;
    const relPaths = await uploadCapturedFramesToStaging(dataUrls);
    pushLog("Encoding video…");
    setRunningStatus("Encoding video…");
    const { videoRelPath } = await apiEncodeFramesVideoToStaging({
      charKey,
      relPaths,
      fps,
      filenameBase: sanitizeDownloadBaseName(filenameBase),
    });
    return { videoRelPath, relPaths };
  }

  async function runMotionVideoExport(
    motionKey: string,
    item: MotionRefListItem,
    exportFps: number,
    label: string
  ) {
    setFpsExportPending(null);
    beginSession({
      title: "Download as Video",
      clearLog: true,
      runningStatus: "Capturing frames…",
    });
    await Promise.resolve();
    try {
      const captured = await captureMotionViewerFrames(motionKey, item, exportFps, {
        mode: "video",
        pushLog,
        setRunningStatus,
      });
      if (captured.mode !== "video" || !captured.dataUrls.length) {
        throw new Error("No frames captured.");
      }

      const relPaths = await uploadCapturedFramesToStaging(captured.dataUrls);
      pushLog("Encoding video…");
      setRunningStatus("Encoding video…");
      await apiExportFramesVideo({
        relPaths,
        fps: exportFps,
        filenameBase: sanitizeDownloadBaseName(label || motionKey),
      });
      pushLog("Download started.");
      endSession();
    } catch (e) {
      failSession(e, "Download as Video failed.");
    }
  }

  async function runV2PoseSeq(
    motionKey: string,
    item: MotionRefListItem,
    folderName: string,
    sampleFps: V2PoseSeqSampleFps,
    useVideoKeypointService: boolean
  ) {
    setV2poseDialog(null);
    beginSession({
      title: useVideoKeypointService ? "V2Pose Seq (video)" : "V2Pose Seq",
      clearLog: true,
      runningStatus: "Capturing frames…",
    });
    await Promise.resolve();
    try {
      const sourceFps = manifest?.fps ?? item.fps ?? 30;
      const encodeFps = encodeFpsFromSample(sampleFps, sourceFps);

      if (useVideoKeypointService) {
        const captured = await captureMotionViewerFrames(motionKey, item, sampleFps, {
          mode: "v2pose",
          pushLog,
          setRunningStatus,
        });
        if (captured.mode !== "v2pose") {
          throw new Error("Unexpected capture mode.");
        }
        const { captures, skippedFrames, clippedFrames } = captured;

        if (skippedFrames.length) {
          pushLog(
            `Skipped ${skippedFrames.length} frame(s) with the figure out of frame. ` +
              `Adjust the camera/zoom (or enable In place) so the output frame stays on the figure.`
          );
        }
        if (clippedFrames.length) {
          pushLog(
            `Warning: ${clippedFrames.length} frame(s) had the SDPose crop touching the output frame edge — ` +
              `the figure may be cut off. Zoom out or recenter for best keypoints.`
          );
        }
        if (!captures.length) {
          throw new Error(
            "No frames captured — the figure was out of frame for the whole range. Recenter the camera and try again."
          );
        }

        pushLog(`Uploading ${captures.length} frames…`);
        const frameRelPaths: string[] = [];
        for (let i = 0; i < captures.length; i++) {
          const c = captures[i];
          setRunningStatus(`Uploading frame ${i + 1}/${captures.length}…`);
          const file = await dataUrlToStagingFile(c.pngBase64, i);
          const { relPath } = await apiUploadStaging({ charKey, file });
          frameRelPaths.push(relPath);
        }

        pushLog("Running video keypoint service…");
        setRunningStatus("Starting video keypoint job…");
        const done = await runReferenceMakeKeypointVideoWsJob({
          frameRelPaths,
          frameMeta: captures.map((c) => ({
            cropBox: c.cropBox,
            imageWidth: c.imageWidth,
            imageHeight: c.imageHeight,
          })),
          fps: encodeFps,
          onLogLine: onJobLogLine,
        });
        if (!done.ok || !done.result?.item) {
          throw new Error(done.error || "Video keypoint generation failed.");
        }
        onKeypointVideoMade?.(done.result.item);
        const frameCount = (done.result.item.frameSequence?.strip ?? []).filter(
          (s) => s.kind === "image"
        ).length;
        pushLog(
          `Done — video keypoint sequence (${frameCount} frame${frameCount === 1 ? "" : "s"}). ` +
            `Saved to reference library as video row.`
        );
        endSession();
        return;
      }

      const captured = await captureMotionViewerFrames(motionKey, item, sampleFps, {
        mode: "v2pose",
        pushLog,
        setRunningStatus,
      });
      if (captured.mode !== "v2pose") {
        throw new Error("Unexpected capture mode.");
      }
      const { captures, skippedFrames, clippedFrames } = captured;

      if (skippedFrames.length) {
        pushLog(
          `Skipped ${skippedFrames.length} frame(s) with the figure out of frame. ` +
            `Adjust the camera/zoom (or enable In place) so the output frame stays on the figure.`
        );
      }
      if (clippedFrames.length) {
        pushLog(
          `Warning: ${clippedFrames.length} frame(s) had the SDPose crop touching the output frame edge — ` +
            `the figure may be cut off. Zoom out or recenter for best keypoints.`
        );
      }
      if (!captures.length) {
        throw new Error(
          "No frames captured — the figure was out of frame for the whole range. Recenter the camera and try again."
        );
      }

      pushLog("Running SDPose…");
      setRunningStatus("Starting SDPose batch…");
      const { folderId, folderName: folder } = await apiMotionRefV2PoseSeqStart(
        motionKey,
        folderName
      );
      const items: PoseReference[] = [];
      for (let i = 0; i < captures.length; i++) {
        const c = captures[i];
        setRunningStatus(`SDPose ${i + 1}/${captures.length}…`);
        pushLog(`SDPose f${c.frameIndex} (${i + 1}/${captures.length})…`);
        const { item } = await apiMotionRefV2PoseSeqFrame(motionKey, folderId, c);
        items.push(item);
      }
      for (const kp of items) {
        onKeypointsMade?.(kp);
      }
      pushLog(`Done — ${items.length} poses in folder ${folder}.`);
      endSession();
    } catch (e) {
      failSession(e, "V2Pose Seq failed.");
    }
  }

  async function runV2PoseDiagShots(
    motionKey: string,
    item: MotionRefListItem,
    sampleFps: V2PoseSeqSampleFps
  ) {
    setV2poseDialog(null);
    beginSession({
      title: "V2Pose Diag Shots",
      clearLog: true,
      runningStatus: "Capturing frames…",
    });
    await Promise.resolve();
    try {
      const captured = await captureMotionViewerFrames(motionKey, item, sampleFps, {
        mode: "v2pose",
        pushLog,
        setRunningStatus,
      });
      if (captured.mode !== "v2pose") throw new Error("Unexpected capture mode.");
      const { captures, skippedFrames } = captured;
      if (skippedFrames.length) {
        pushLog(`Skipped ${skippedFrames.length} frame(s) with figure out of frame.`);
      }
      if (!captures.length) {
        throw new Error("No frames captured — figure was out of frame for the whole range.");
      }
      const now = new Date();
      const pad2 = (n: number) => String(n).padStart(2, "0");
      const folderName = `diag ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      const { folderId, folderName: savedFolder } = await apiMotionRefDiagShotsStart(motionKey, folderName);
      pushLog(`Saving ${captures.length} diagnostic shots to "${savedFolder}"…`);
      for (let i = 0; i < captures.length; i++) {
        setRunningStatus(`Saving shot ${i + 1}/${captures.length}…`);
        await apiMotionRefDiagShotsFrame(motionKey, folderId, captures[i]);
      }
      await loadShotsLayout();
      pushLog(
        `Done — ${captures.length} composite shots in Shots gallery folder "${savedFolder}". Right-click the folder to rename.`
      );
      endSession();
    } catch (e) {
      failSession(e, "Diag shots failed.");
    }
  }

  const timeLabel = useMemo(() => {
    if (totalFrames === 0) return "— / —";
    const fps = manifest?.fps ?? 30;
    const rel = frameIndex - playbackStart;
    const span = Math.max(1, playbackEnd - playbackStart + 1);
    const cur = (frameIndex / fps).toFixed(1);
    const tot = (totalFrames / fps).toFixed(1);
    return `f${frameIndex} (${rel + 1}/${span})  ${cur}s / ${tot}s`;
  }, [frameIndex, totalFrames, manifest, playbackStart, playbackEnd]);

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
        zIndex: 10200, // above TimelineCharacterPicker (9998) and ReferencePicker (10000)
      }}
      onMouseDown={() => {
        if (motionCtxMenu) { setMotionCtxMenu(null); return; }
        if (cameraCtxMenu) { setCameraCtxMenu(null); return; }
        if (fpsExportPending || v2poseDialog || jobModalProps.open) return;
        onClose();
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          if (motionCtxMenu) { e.preventDefault(); setMotionCtxMenu(null); }
          if (cameraCtxMenu) { e.preventDefault(); setCameraCtxMenu(null); }
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
            captureAspect={captureAspect}
            onCameraChange={(s) => setCameraState(s)}
            onUserOrbitChange={(orbiting) => { userOrbitingRef.current = orbiting; }}
            onUserCameraInteract={(active) => {
              if (active) userCameraOverrideRef.current = true;
            }}
            onGizmoContextMenu={(id, x, y) => setCameraCtxMenu({ id, x, y })}
          />
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
            <div style={{ fontSize: 10, color: "#555" }}>
              {displayMode === "mesh" ? "Mesh preview" : "Skeleton preview"}
              {" · "}Drag to slide · Shift+drag to orbit · Scroll to zoom · Drag corner to resize
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 10, color: "#888" }}>Aspect</span>
                {SEQUENCE_PREVIEW_ASPECT_OPTIONS.map((opt) => (
                  <CaptureAspectButton
                    key={opt.id}
                    w={opt.w}
                    h={opt.h}
                    label={opt.label}
                    selected={captureAspect === opt.id}
                    onSelect={() => setCaptureAspect(opt.id)}
                  />
                ))}
              </div>
              <label
                style={{ fontSize: 10, color: showOutputFrame ? "#ddd" : "#888", display: "flex", alignItems: "center", gap: 4, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                title="Show fixed-aspect shot boundary (saved PNG matches this frame)"
              >
                <input
                  type="checkbox"
                  checked={showOutputFrame}
                  onChange={(e) => setShowOutputFrame(e.target.checked)}
                  style={{ accentColor: "#ccc" }}
                />
                Output frame
              </label>
              <label
                style={{ fontSize: 10, color: showCropFrame ? "#6eb5ff" : "#888", display: "flex", alignItems: "center", gap: 4, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
                title="Show figure crop sent to SDPose for this frame"
              >
                <input
                  type="checkbox"
                  checked={showCropFrame}
                  onChange={(e) => setShowCropFrame(e.target.checked)}
                  style={{ accentColor: "#6eb5ff" }}
                />
                SDPose crop
              </label>
            </div>
          </div>
        </div>

        {/* Playback controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <SquareIconButton
            size={32}
            aria-label="Go to trim start"
            title="Go to trim start"
            disabled={totalFrames === 0}
            icon={<TriangleIcon direction="left" size={12} />}
            onClick={() => {
              setPlaying(false);
              setFrameIndex(playbackStart);
            }}
          />
          <SquareIconButton
            size={32}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause" : "Play"}
            disabled={totalFrames === 0}
            icon={playing ? <PauseBarsIcon /> : <TimelinePlayIcon />}
            onClick={() => {
              setPlaying((p) => {
                if (!p) userCameraOverrideRef.current = false;
                return !p;
              });
            }}
          />
          <SquareIconButton
            size={32}
            aria-label="Step forward"
            title="Step forward"
            disabled={totalFrames === 0}
            icon={<TriangleIcon direction="right" size={12} />}
            onClick={() => setFrameIndex((i) => Math.min(playbackEnd, i + 1))}
          />
          <span style={{ fontSize: 11, color: "#aaa", fontVariantNumeric: "tabular-nums", minWidth: 160 }}>{timeLabel}</span>
          <MotionPlaybackScrubber
            totalFrames={totalFrames}
            frameIndex={frameIndex}
            playbackStart={playbackStart}
            playbackEnd={playbackEnd}
            cameraKeyframes={cameraKeyframes}
            disabled={busy || totalFrames === 0}
            onFrameChange={(f) => {
              setPlaying(false);
              setFrameIndex(f);
            }}
            onRangeChange={handlePlaybackRangeChange}
            onCameraKeyframeClick={jumpToCameraKeyframe}
            onCameraKeyframeContextMenu={(kf, x, y) => setCameraCtxMenu({ id: kf.id, x, y })}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <label
              style={{
                fontSize: 11,
                color:
                  cameraKeyframes.length === 0
                    ? "#555"
                    : trajectoryEnabled
                      ? MOTION_REF_ACCENT
                      : "#888",
                display: "flex",
                alignItems: "center",
                gap: 4,
                cursor: cameraKeyframes.length === 0 ? "default" : "pointer",
                userSelect: "none",
                whiteSpace: "nowrap",
              }}
              title="Follow saved camera keyframes during playback"
            >
              <input
                type="checkbox"
                checked={trajectoryEnabled}
                disabled={cameraKeyframes.length === 0}
                onChange={(e) => setTrajectoryEnabled(e.target.checked)}
                style={{ accentColor: MOTION_REF_ACCENT }}
              />
              Trajectory
            </label>
            <label
              style={{ fontSize: 11, color: inPlace ? MOTION_REF_ACCENT : "#888", display: "flex", alignItems: "center", gap: 4, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
              title="Remove horizontal root translation so the figure stays centered during playback (recommended for trajectory and shots)"
            >
              <input
                type="checkbox"
                checked={inPlace}
                onChange={(e) => {
                  const next = e.target.checked;
                  if (!next && cameraKeyframes.length > 0) {
                    void confirmAction({
                      title: "Disable In place?",
                      message:
                        "Camera trajectory and shots assume the figure stays centered. Turning off In place may move the figure out of view during playback.",
                      confirmText: "Disable",
                    }).then((ok) => {
                      if (ok) setInPlace(false);
                    });
                    return;
                  }
                  setInPlace(next);
                }}
                style={{ accentColor: MOTION_REF_ACCENT }}
              />
              In place
            </label>
          </div>
        </div>

        {/* Prompt adherence */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <PromptAdherenceKnob
            value={promptAdherence}
            onChange={setPromptAdherence}
            disabled={busy}
          />
        </div>

        {/* Motion segments */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <MotionTimeline segments={segments} onChange={setSegments} disabled={busy} />
        </div>

        {/* Actions: Generate · Reset · Save Shot · Add Trajectory */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 16px", flexWrap: "wrap", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
          <button
            type="button" onClick={() => void runGenerate()} disabled={busy}
            title="Generate a fresh KiMoD motion sequence from the text segments"
            style={actionBtn}
          >
            Generate
          </button>
          <button
            type="button" onClick={handleResetCamera} disabled={busy}
            title="Reset the camera to defaults" style={actionBtn}
          >
            Reset
          </button>
          <button
            type="button" onClick={() => void saveShot()} disabled={busy || !manifest}
            title="Bookmark this frame and camera angle in the Shots gallery"
            style={actionBtn}
          >
            Save Shot
          </button>
          <button
            type="button" onClick={() => void saveTrajectoryKeyframe()} disabled={busy || !manifest}
            title="Add the current camera pose at this frame to the playback trajectory"
            style={actionBtn}
          >
            Add Trajectory
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
                    title={`${label} — ${m.frameCount} frames @ ${m.fps} fps\nClick to load · Right-click for menu`}
                    style={{
                      width: 90,
                      cursor: busy ? "not-allowed" : "pointer",
                      border: isActive ? `1px solid ${MOTION_REF_ACCENT_BORDER}` : "1px solid rgba(255,255,255,0.15)",
                      background: isActive ? MOTION_REF_ACCENT_BG : "rgba(255,255,255,0.04)",
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

        {/* Shots gallery */}
        <div style={{ padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <div style={{ fontSize: 11, color: "#aaa", marginBottom: 8 }}>
            Shots
          </div>
          <MotionShotGallery
            busy={busy}
            layout={shotsLayout}
            onLayoutChange={setShotsLayout}
            selectedIds={selectedShotIds}
            onSelectedIdsChange={setSelectedShotIds}
            onRestoreShot={(shot) => void restoreShot(shot)}
            onAddToPose={(shots) => void addShotsToPose(shots)}
            onDeleteShot={(id) => void deleteShot(id)}
            onCreateFolder={(parentId, shotIds) => void createShotFolder(parentId, shotIds)}
            onRenameFolder={(id, name) => void renameShotFolder(id, name)}
            onDeleteFolder={(id) => void deleteShotFolder(id)}
            jobModal={{
              begin: beginSession,
              end: endSession,
              fail: failSession,
              log: pushLog,
            }}
          />
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
            zIndex: 10300,
            minWidth: 140,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onMouseLeave={() => setMotionCtxMenu(null)}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const item = motions.find((m) => m.motionKey === motionCtxMenu.motionKey);
              if (!item) return;
              const label =
                item.segments?.[0]?.text?.slice(0, 24) || item.motionKey.slice(0, 20);
              setMotionCtxMenu(null);
              setFpsExportPending({
                motionKey: item.motionKey,
                item,
                label,
              });
            }}
            style={ctxMenuBtn}
          >
            Download as Video
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const item = motions.find((m) => m.motionKey === motionCtxMenu.motionKey);
              if (!item) return;
              const label = item.segments?.[0]?.text?.slice(0, 24) || item.motionKey.slice(0, 20);
              setMotionCtxMenu(null);
              setV2poseDialog({
                motionKey: item.motionKey,
                label,
                sampleFps: "source",
                folderName: `v2pose_${item.motionKey.slice(0, 20)}_${Date.now()}`,
                useVideoKeypointService: false,
                noSdpose: false,
              });
            }}
            style={ctxMenuBtn}
          >
            V2Pose Seq
          </button>
          <button
            type="button"
            onClick={() => void deleteMotion(motionCtxMenu.motionKey)}
            style={ctxMenuBtn}
          >
            Delete motion
          </button>
        </div>
      )}

      {fpsExportPending && (
        <ExportFpsDialog
          open
          title="Download as Video"
          zIndex={10450}
          defaultFps={Math.round(fpsExportPending.item.fps) || 24}
          onCancel={() => setFpsExportPending(null)}
          onConfirm={(fps) => {
            void runMotionVideoExport(
              fpsExportPending.motionKey,
              fpsExportPending.item,
              fps,
              fpsExportPending.label
            );
          }}
        />
      )}

      {v2poseDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 10400,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setV2poseDialog(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#1a1a1a",
              border: "1px solid rgba(255,255,255,0.2)",
              padding: 20,
              minWidth: 320,
              color: "#eee",
            }}
          >
            <div style={{ fontSize: 14, marginBottom: 12 }}>V2Pose Seq</div>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 12 }}>
              {v2poseDialog.label} · trim f{playbackStart}–f{playbackEnd}
              {cameraKeyframes.length === 0 ? " · no trajectory (uses current camera)" : ""}
            </div>
            <label style={{ display: "block", fontSize: 11, marginBottom: 6 }}>Sample rate</label>
            <select
              value={String(v2poseDialog.sampleFps)}
              onChange={(e) => {
                const v = e.target.value;
                const sampleFps: V2PoseSeqSampleFps =
                  v === "12" ? 12 : v === "24" ? 24 : "source";
                setV2poseDialog((d) => (d ? { ...d, sampleFps } : d));
              }}
              style={{ width: "100%", marginBottom: 12, padding: 8, background: "#111", border: "1px solid #444", color: "#eee" }}
            >
              <option value="source">Source fps (every frame in trim)</option>
              <option value="12">12 fps</option>
              <option value="24">24 fps</option>
            </select>
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                fontSize: 11,
                marginBottom: 12,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={v2poseDialog.noSdpose}
                onChange={(e) =>
                  setV2poseDialog((d) =>
                    d ? { ...d, noSdpose: e.target.checked } : d
                  )
                }
                style={{ marginTop: 2 }}
              />
              <span>
                No SDPose (diagnostic shots only)
                <span style={{ display: "block", color: "#888", marginTop: 4 }}>
                  Saves composite previews (zoom pasted at crop position on full canvas) to the
                  Shots gallery as a dated folder. Use to verify zoom and placement before
                  running SDPose. Right-click the folder to rename.
                </span>
              </span>
            </label>
            {!v2poseDialog.noSdpose && (
              <label
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  fontSize: 11,
                  marginBottom: 12,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={v2poseDialog.useVideoKeypointService}
                  onChange={(e) =>
                    setV2poseDialog((d) =>
                      d ? { ...d, useVideoKeypointService: e.target.checked } : d
                    )
                  }
                  style={{ marginTop: 2 }}
                />
                <span>
                  Use video keypoint service (creates video row)
                  <span style={{ display: "block", color: "#888", marginTop: 4 }}>
                    Faster for long trims; one SDPose pass on cropped-square video with per-frame
                    placement restored. Inspect via the video keypoint sequence editor.
                  </span>
                </span>
              </label>
            )}
            {!v2poseDialog.noSdpose && !v2poseDialog.useVideoKeypointService ? (
              <>
                <label style={{ display: "block", fontSize: 11, marginBottom: 6 }}>Pose folder name</label>
                <input
                  value={v2poseDialog.folderName}
                  onChange={(e) =>
                    setV2poseDialog((d) => (d ? { ...d, folderName: e.target.value } : d))
                  }
                  style={{ width: "100%", marginBottom: 12, padding: 8, background: "#111", border: "1px solid #444", color: "#eee" }}
                />
              </>
            ) : null}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setV2poseDialog(null)} style={actionBtn}>
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  busy ||
                  (!v2poseDialog.noSdpose &&
                    !v2poseDialog.useVideoKeypointService &&
                    !v2poseDialog.folderName.trim())
                }
                onClick={() => {
                  const item = motions.find((m) => m.motionKey === v2poseDialog.motionKey);
                  if (!item) return;
                  if (v2poseDialog.noSdpose) {
                    void runV2PoseDiagShots(
                      v2poseDialog.motionKey,
                      item,
                      v2poseDialog.sampleFps
                    );
                  } else {
                    void runV2PoseSeq(
                      v2poseDialog.motionKey,
                      item,
                      v2poseDialog.folderName.trim() ||
                        `v2pose_${v2poseDialog.motionKey.slice(0, 20)}`,
                      v2poseDialog.sampleFps,
                      v2poseDialog.useVideoKeypointService
                    );
                  }
                }}
                style={{ ...actionBtn, background: MOTION_REF_ACCENT_BTN_BG }}
              >
                Run
              </button>
            </div>
          </div>
        </div>
      )}

      {cameraCtxMenu && (() => {
        const kf = cameraKeyframes.find((k) => k.id === cameraCtxMenu.id);
        return (
          <CameraKeyframeContextMenu
            x={cameraCtxMenu.x}
            y={cameraCtxMenu.y}
            holdFrames={kf?.holdFrames ?? 0}
            blendEase={kf?.blendEase ?? DEFAULT_BLEND_EASE}
            maxHold={maxHoldForKeyframe(cameraCtxMenu.id)}
            onPatchSave={(patch) => saveCameraKeyframePatch(cameraCtxMenu.id, patch)}
            onDelete={() => void deleteCameraKeyframe(cameraCtxMenu.id)}
            onClose={() => setCameraCtxMenu(null)}
          />
        );
      })()}

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

const actionBtn: React.CSSProperties = {
  background: "transparent",
  color: "#eee",
  border: "1px solid rgba(255,255,255,0.4)",
  padding: "7px 14px",
  cursor: "pointer",
  font: "inherit",
};

const ctxMenuBtn: React.CSSProperties = {
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
};

const headerBtn: React.CSSProperties = {
  background: "transparent",
  color: "#aaa",
  border: "1px solid rgba(255,255,255,0.2)",
  padding: "4px 10px",
  cursor: "pointer",
  font: "inherit",
};
