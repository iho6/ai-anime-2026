"use client";

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { keyframeWorldPose, orbitStateFromWorldPose, worldPoseFromOrbitState } from "./cameraTrajectory";
import type { CameraWorldPose } from "./cameraTrajectory";
import { computeCaptureViewportLayout } from "./captureViewportLayout";
import type { SequencePreviewAspect } from "../../lib/api";
import { normalizeSequencePreviewAspect, aspectDimensionsForId } from "../../lib/sequenceAspect";

export type CameraGizmoKeyframe = {
  id: string;
  frameIndex: number;
  azimuth: number;
  elevation: number;
  distance: number;
  slideX?: number;
  slideY?: number;
  cameraPosition?: [number, number, number];
  lookAtTarget?: [number, number, number];
};

export type CameraState = {
  azimuth: number;   // degrees
  elevation: number; // degrees
  distance: number;  // world units (metres)
  /** Screen-slide offset along camera right (world units). */
  slideX: number;
  /** Screen-slide offset along camera up (world units). */
  slideY: number;
};

export type ViewerMode = "mesh" | "bones";

export type FigureScreenBbox = {
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
};

export type SkeletonViewer3DHandle = {
  /** Switch between skinned mesh and joint skeleton preview. */
  setMode(mode: ViewerMode): void;
  /** Set bone parent/child index pairs for skeleton mode. */
  setBonePairs(pairs: [number, number][]): void;
  /** Set the static SMPL-X face index buffer (flat triples). Call once per mesh. */
  setFaces(indices: Uint32Array): void;
  /** Update the mesh to a frame's vertex positions (flat Float32Array, length V*3). */
  setFrame(positions: Float32Array): void;
  /** Update skeleton bones from joint positions (flat Float32Array, length J*3). */
  setJointFrame(positions: Float32Array): void;
  /** Fix the ground plane + camera target for the whole motion (call once after load). */
  setFraming(groundY: number, centerY: number): void;
  /** Get current camera orbit state. */
  getCameraState(): CameraState;
  /** Restore orbit angles and optionally distance. */
  setCameraState(
    state: Partial<CameraState> & Pick<CameraState, "azimuth" | "elevation">
  ): void;
  /** Place camera-pose gizmo markers in the scene (hidden during capture). */
  setCameraGizmos(keyframes: CameraGizmoKeyframe[], centerY: number): void;
  setGizmosVisible(visible: boolean): void;
  getViewerCenterY(): number;
  /** Current world-space camera position and look-at target. */
  getCameraWorldPose(): CameraWorldPose;
  /** Apply world pose directly; syncs orbitRef for getCameraState(). */
  setCameraWorldPose(position: [number, number, number], target: [number, number, number]): void;
  /** Reset orbit camera to defaults without clearing mesh geometry. */
  resetCamera(): void;
  /** Reset the camera to defaults and hide geometry. */
  resetAll(): void;
  /** Capture the current canvas as a PNG data URL. */
  captureFrame(): string | null;
  /**
   * Zoom camera so the figure fills ~fillFraction of a targetSize×targetSize square,
   * render at that resolution, compute the figure bbox, then restore the camera.
   * Returns null if the figure is not visible.
   */
  captureFrameAutoFit(opts?: {
    targetSize?: number;
    fillFraction?: number;
  }): { dataUrl: string; screenBbox: FigureScreenBbox } | null;
  /** Screen-space figure AABB for crop placement (motion-ref keypoint pipeline). */
  getFigureScreenBbox(): FigureScreenBbox | null;
  /** Toggle the live crop-frame overlay (square fed to SDPose). */
  setCropOverlayVisible(visible: boolean): void;
  /** Toggle the fixed-aspect output frame overlay (red border + outside dim). */
  setOutputFrameOverlayVisible(visible: boolean): void;
  /** Update capture aspect ratio (16:9, 9:16, 1:1, 4:3). */
  setCaptureAspect(aspect: SequencePreviewAspect): void;
  /**
   * Render the current frame at the capture-aspect output resolution WITHOUT
   * changing the camera (no auto-zoom). The exported pixels exactly match the
   * live preview. Returns null if the figure is not visible at all.
   */
  captureFrameAtAspect(opts?: {
    targetSize?: number;
  }): { dataUrl: string; screenBbox: FigureScreenBbox } | null;
};

type Props = {
  width?: number | string;
  height?: number | string;
  captureAspect?: SequencePreviewAspect;
  onCameraChange?: (state: CameraState) => void;
  onUserOrbitChange?: (orbiting: boolean) => void;
  onUserCameraInteract?: (active: boolean) => void;
  onGizmoContextMenu?: (keyframeId: string, clientX: number, clientY: number) => void;
};

const DEFAULT_ORBIT: CameraState = {
  azimuth: 20,
  elevation: 15,
  distance: 2.6,
  slideX: 0,
  slideY: 0,
};
const TAN_HALF_FOV = Math.tan((45 * 0.5) * Math.PI / 180); // FOV=45 fixed at camera creation
const ZOOM_FACTOR = 0.001;
const FALLBACK_W = 380;
const FALLBACK_H = 320;
const FIGURE_CROP_PAD_FRAC = 0.15;
const MIN_CROP_SIZE = 64;

function padClampFigureBbox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  imgW: number,
  imgH: number
): { x: number; y: number; width: number; height: number } {
  let minX = Math.min(x1, x2);
  let minY = Math.min(y1, y2);
  let maxX = Math.max(x1, x2);
  let maxY = Math.max(y1, y2);
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const padX = bw * FIGURE_CROP_PAD_FRAC;
  const padY = bh * FIGURE_CROP_PAD_FRAC;
  minX -= padX;
  minY -= padY;
  maxX += padX;
  maxY += padY;
  let ix1 = Math.max(0, Math.min(imgW - 1, Math.round(minX)));
  let iy1 = Math.max(0, Math.min(imgH - 1, Math.round(minY)));
  let ix2 = Math.max(ix1 + 1, Math.min(imgW, Math.round(maxX)));
  let iy2 = Math.max(iy1 + 1, Math.min(imgH, Math.round(maxY)));
  let w = ix2 - ix1;
  let h = iy2 - iy1;
  if (w < MIN_CROP_SIZE) {
    const extra = MIN_CROP_SIZE - w;
    ix1 = Math.max(0, ix1 - Math.floor(extra / 2));
    ix2 = Math.min(imgW, ix1 + MIN_CROP_SIZE);
    ix1 = Math.max(0, ix2 - MIN_CROP_SIZE);
    w = ix2 - ix1;
  }
  if (h < MIN_CROP_SIZE) {
    const extra = MIN_CROP_SIZE - h;
    iy1 = Math.max(0, iy1 - Math.floor(extra / 2));
    iy2 = Math.min(imgH, iy1 + MIN_CROP_SIZE);
    iy1 = Math.max(0, iy2 - MIN_CROP_SIZE);
    h = iy2 - iy1;
  }
  return { x: ix1, y: iy1, width: w, height: h };
}

function padClampSquareFigureBbox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  imgW: number,
  imgH: number
): { x: number; y: number; width: number; height: number } {
  const rect = padClampFigureBbox(x1, y1, x2, y2, imgW, imgH);
  const side = Math.max(rect.width, rect.height);
  let cx = rect.x + rect.width / 2;
  let cy = rect.y + rect.height / 2;
  let nx = Math.round(cx - side / 2);
  let ny = Math.round(cy - side / 2);
  if (nx < 0) nx = 0;
  if (ny < 0) ny = 0;
  if (nx + side > imgW) nx = Math.max(0, imgW - side);
  if (ny + side > imgH) ny = Math.max(0, imgH - side);
  const clampedSide = Math.min(side, imgW - nx, imgH - ny);
  return { x: nx, y: ny, width: clampedSide, height: clampedSide };
}

type ThreeModule = typeof import("three");

const SkeletonViewer3D = forwardRef<SkeletonViewer3DHandle, Props>(
  ({
    width = "100%",
    height = 320,
    captureAspect = "16:9",
    onCameraChange,
    onUserOrbitChange,
    onUserCameraInteract,
    onGizmoContextMenu,
  }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewportHostRef = useRef<HTMLDivElement | null>(null);
    const outputFrameOverlayRef = useRef<HTMLDivElement | null>(null);
    const cropOverlayRef = useRef<HTMLDivElement | null>(null);

    const threeRef = useRef<{
      THREE: ThreeModule;
      renderer: import("three").WebGLRenderer;
      scene: import("three").Scene;
      camera: import("three").PerspectiveCamera;
      grid: import("three").GridHelper;
      mesh: import("three").Mesh;
      geometry: import("three").BufferGeometry;
      boneLines: import("three").LineSegments;
      boneGeometry: import("three").BufferGeometry;
      gizmoGroup: import("three").Group;
      gizmoPickables: import("three").Object3D[];
      animFrameId: number;
    } | null>(null);

    const gizmosVisibleRef = useRef(true);
    const gizmoKeyframesRef = useRef<CameraGizmoKeyframe[]>([]);
    const showCropOverlayRef = useRef(true);
    const showOutputFrameOverlayRef = useRef(true);
    const captureAspectRef = useRef<SequencePreviewAspect>(normalizeSequencePreviewAspect(captureAspect));

    const modeRef = useRef<ViewerMode>("mesh");
    const bonePairsRef = useRef<[number, number][]>([]);
    const positionsRef = useRef<Float32Array | null>(null);

    const orbitRef = useRef({ ...DEFAULT_ORBIT });
    const centerYRef = useRef(0.9);
    const lastLookAtRef = useRef<[number, number, number]>([0, 0.9, 0]);
    const sizeRef = useRef({
      w: typeof width === "number" ? width : FALLBACK_W,
      h: typeof height === "number" ? height : FALLBACK_H,
    });
    const resizeObsRef = useRef<ResizeObserver | null>(null);

    const onCameraChangeRef = useRef(onCameraChange);
    onCameraChangeRef.current = onCameraChange;
    const onUserOrbitChangeRef = useRef(onUserOrbitChange);
    onUserOrbitChangeRef.current = onUserOrbitChange;
    const onUserCameraInteractRef = useRef(onUserCameraInteract);
    onUserCameraInteractRef.current = onUserCameraInteract;
    const onGizmoContextMenuRef = useRef(onGizmoContextMenu);
    onGizmoContextMenuRef.current = onGizmoContextMenu;

    const pointerRef = useRef({ down: false, lastX: 0, lastY: 0, orbiting: false });
    const pendingFacesRef = useRef<Uint32Array | null>(null);
    const pendingFramingRef = useRef<{ groundY: number; centerY: number } | null>(null);

    function _applyFaces(indices: Uint32Array) {
      const t = threeRef.current;
      if (!t) {
        pendingFacesRef.current = indices;
        return;
      }
      pendingFacesRef.current = null;
      t.geometry.setIndex(new t.THREE.BufferAttribute(indices, 1));
    }

    function _applyFraming(groundY: number, centerY: number) {
      const t = threeRef.current;
      if (!t) {
        pendingFramingRef.current = { groundY, centerY };
        return;
      }
      pendingFramingRef.current = null;
      t.grid.position.y = groundY;
      centerYRef.current = centerY;
      _applyCameraToThree();
    }

    function _applyVisibility() {
      const t = threeRef.current;
      if (!t) return;
      const mode = modeRef.current;
      const hasMeshData =
        positionsRef.current != null && positionsRef.current.length >= 3;
      t.mesh.visible = mode === "mesh" && hasMeshData;
      t.boneLines.visible = mode === "bones";
    }

    function _applyCameraToThree() {
      const t = threeRef.current;
      if (!t) return;
      const { azimuth, elevation, distance, slideX, slideY } = orbitRef.current;
      const phi = (90 - elevation) * (Math.PI / 180);
      const theta = azimuth * (Math.PI / 180);
      const cy = centerYRef.current;
      t.camera.position.set(
        distance * Math.sin(phi) * Math.sin(theta),
        cy + distance * Math.cos(phi),
        distance * Math.sin(phi) * Math.cos(theta)
      );
      t.camera.lookAt(0, cy, 0);
      t.camera.updateMatrixWorld(true);
      const right = new t.THREE.Vector3();
      const up = new t.THREE.Vector3();
      right.setFromMatrixColumn(t.camera.matrix, 0);
      up.setFromMatrixColumn(t.camera.matrix, 1);
      const target = new t.THREE.Vector3(0, cy, 0);
      target.addScaledVector(right, slideX);
      target.addScaledVector(up, slideY);
      t.camera.position.addScaledVector(right, slideX);
      t.camera.position.addScaledVector(up, slideY);
      t.camera.lookAt(target);
      lastLookAtRef.current = [target.x, target.y, target.z];
    }

    function _computeFigureScreenBbox(): FigureScreenBbox | null {
      const t = threeRef.current;
      const positions = positionsRef.current;
      if (!t || !positions || positions.length < 3) return null;
      const { THREE, camera, renderer } = t;
      const imgW = renderer.domElement.width;
      const imgH = renderer.domElement.height;
      if (imgW < 1 || imgH < 1) return null;
      const vec = new THREE.Vector3();
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        vec.set(positions[i], positions[i + 1], positions[i + 2]);
        vec.project(camera);
        if (vec.z < -1 || vec.z > 1) continue;
        const px = (vec.x * 0.5 + 0.5) * imgW;
        const py = (-vec.y * 0.5 + 0.5) * imgH;
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
      }
      if (!Number.isFinite(minX)) return null;
      const box = padClampSquareFigureBbox(minX, minY, maxX, maxY, imgW, imgH);
      return { ...box, imageWidth: imgW, imageHeight: imgH };
    }

    function _applyViewportLayout() {
      const container = containerRef.current;
      const viewportHost = viewportHostRef.current;
      const outputOverlay = outputFrameOverlayRef.current;
      const t = threeRef.current;
      if (!container || !viewportHost) return;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      if (cw < 1 || ch < 1) return;
      const layout = computeCaptureViewportLayout(cw, ch, captureAspectRef.current);
      viewportHost.style.left = `${layout.x}px`;
      viewportHost.style.top = `${layout.y}px`;
      viewportHost.style.width = `${layout.width}px`;
      viewportHost.style.height = `${layout.height}px`;
      if (outputOverlay) {
        outputOverlay.style.left = `${layout.x}px`;
        outputOverlay.style.top = `${layout.y}px`;
        outputOverlay.style.width = `${layout.width}px`;
        outputOverlay.style.height = `${layout.height}px`;
      }
      sizeRef.current = { w: layout.width, h: layout.height };
      if (t) {
        t.renderer.setSize(layout.width, layout.height);
        t.camera.aspect = layout.width / layout.height;
        t.camera.updateProjectionMatrix();
      }
      _updateOutputFrameOverlay();
    }

    function _updateOutputFrameOverlay() {
      const el = outputFrameOverlayRef.current;
      if (!el) return;
      if (!showOutputFrameOverlayRef.current) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
    }

    function _updateCropOverlay() {
      const el = cropOverlayRef.current;
      if (!el) return;
      const visible = showCropOverlayRef.current && gizmosVisibleRef.current;
      if (!visible) {
        el.style.display = "none";
        return;
      }
      const box = _computeFigureScreenBbox();
      if (!box) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      el.style.left = `${(box.x / box.imageWidth) * 100}%`;
      el.style.top = `${(box.y / box.imageHeight) * 100}%`;
      el.style.width = `${(box.width / box.imageWidth) * 100}%`;
      el.style.height = `${(box.height / box.imageHeight) * 100}%`;
      el.style.borderColor = "rgba(110,181,255,0.9)";
    }

    function _addFrustumGizmo(
      THREE: ThreeModule,
      gizmoGroup: import("three").Group,
      gizmoPickables: import("three").Object3D[],
      camPos: import("three").Vector3,
      target: import("three").Vector3,
      keyframeId: string,
    ) {
      const forward = target.clone().sub(camPos);
      const dist = forward.length();
      if (dist < 1e-6) return;
      forward.normalize();
      const worldUp = new THREE.Vector3(0, 1, 0);
      let right = new THREE.Vector3().crossVectors(forward, worldUp);
      if (right.lengthSq() < 1e-8) {
        right.set(1, 0, 0);
      } else {
        right.normalize();
      }
      const up = new THREE.Vector3().crossVectors(right, forward).normalize();
      const halfW = 0.09;
      const halfH = 0.065;
      const corners = [
        camPos.clone().addScaledVector(right, -halfW).addScaledVector(up, halfH),
        camPos.clone().addScaledVector(right, halfW).addScaledVector(up, halfH),
        camPos.clone().addScaledVector(right, halfW).addScaledVector(up, -halfH),
        camPos.clone().addScaledVector(right, -halfW).addScaledVector(up, -halfH),
      ];
      const planeGeo = new THREE.BufferGeometry();
      const planeVerts = new Float32Array([
        corners[0].x, corners[0].y, corners[0].z,
        corners[1].x, corners[1].y, corners[1].z,
        corners[2].x, corners[2].y, corners[2].z,
        corners[0].x, corners[0].y, corners[0].z,
        corners[2].x, corners[2].y, corners[2].z,
        corners[3].x, corners[3].y, corners[3].z,
      ]);
      planeGeo.setAttribute("position", new THREE.BufferAttribute(planeVerts, 3));
      const planeMat = new THREE.MeshBasicMaterial({
        color: 0x6eb5ff,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const plane = new THREE.Mesh(planeGeo, planeMat);
      plane.userData.keyframeId = keyframeId;
      gizmoGroup.add(plane);
      gizmoPickables.push(plane);

      const edgeMat = new THREE.LineBasicMaterial({
        color: 0x6eb5ff,
        transparent: true,
        opacity: 0.75,
        depthWrite: false,
      });
      for (const c of corners) {
        const edgeGeo = new THREE.BufferGeometry().setFromPoints([c, target]);
        gizmoGroup.add(new THREE.Line(edgeGeo, edgeMat));
      }
      const rectLoop = new THREE.BufferGeometry().setFromPoints([
        ...corners,
        corners[0],
      ]);
      gizmoGroup.add(new THREE.Line(rectLoop, edgeMat));

      const lineGeo = new THREE.BufferGeometry().setFromPoints([camPos, target]);
      gizmoGroup.add(
        new THREE.Line(
          lineGeo,
          new THREE.LineBasicMaterial({
            color: 0x6eb5ff,
            transparent: true,
            opacity: 0.35,
            depthWrite: false,
          })
        )
      );
    }

    function _rebuildGizmos(keyframes: CameraGizmoKeyframe[], centerY: number) {
      const t = threeRef.current;
      if (!t) return;
      const { THREE, gizmoGroup } = t;
      while (gizmoGroup.children.length > 0) {
        const child = gizmoGroup.children[0];
        gizmoGroup.remove(child);
        if ("geometry" in child && child.geometry) {
          (child.geometry as import("three").BufferGeometry).dispose();
        }
        if ("material" in child && child.material) {
          const mat = child.material as import("three").Material | import("three").Material[];
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      }
      t.gizmoPickables = [];
      for (const kf of keyframes) {
        const pose = keyframeWorldPose(kf, centerY);
        const camPos = new THREE.Vector3(
          pose.position[0],
          pose.position[1],
          pose.position[2],
        );
        const target = new THREE.Vector3(
          pose.target[0],
          pose.target[1],
          pose.target[2],
        );
        _addFrustumGizmo(THREE, gizmoGroup, t.gizmoPickables, camPos, target, kf.id);
      }
      gizmoGroup.visible = gizmosVisibleRef.current;
    }

    function _pickGizmo(clientX: number, clientY: number): string | null {
      const t = threeRef.current;
      const viewportHost = viewportHostRef.current;
      if (!t || !viewportHost || t.gizmoPickables.length === 0) return null;
      const rect = viewportHost.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
      const raycaster = new t.THREE.Raycaster();
      raycaster.setFromCamera(new t.THREE.Vector2(ndcX, ndcY), t.camera);
      const hits = raycaster.intersectObjects(t.gizmoPickables, false);
      if (hits.length === 0) return null;
      const id = hits[0].object.userData?.keyframeId;
      return typeof id === "string" ? id : null;
    }

    function _updateBoneLines(positions: Float32Array) {
      const t = threeRef.current;
      if (!t || bonePairsRef.current.length === 0) return;
      const pairs = bonePairsRef.current;
      const verts = new Float32Array(pairs.length * 6);
      for (let i = 0; i < pairs.length; i++) {
        const [child, parent] = pairs[i];
        const ci = child * 3;
        const pi = parent * 3;
        const o = i * 6;
        verts[o] = positions[pi];
        verts[o + 1] = positions[pi + 1];
        verts[o + 2] = positions[pi + 2];
        verts[o + 3] = positions[ci];
        verts[o + 4] = positions[ci + 1];
        verts[o + 5] = positions[ci + 2];
      }
      const geo = t.boneGeometry;
      const existing = geo.getAttribute("position") as
        | import("three").BufferAttribute
        | undefined;
      if (!existing || existing.array.length !== verts.length) {
        geo.setAttribute("position", new t.THREE.BufferAttribute(verts, 3));
      } else {
        (existing.array as Float32Array).set(verts);
        existing.needsUpdate = true;
      }
      geo.computeBoundingSphere();
      t.boneLines.visible = modeRef.current === "bones";
    }

    useEffect(() => {
      captureAspectRef.current = normalizeSequencePreviewAspect(captureAspect);
      _applyViewportLayout();
    }, [captureAspect]);

    useEffect(() => {
      const container = containerRef.current;
      const viewportHost = viewportHostRef.current;
      if (!container || !viewportHost) return;
      let cancelled = false;

      const onWheelNative = (e: WheelEvent) => {
        e.preventDefault();
        orbitRef.current.distance = Math.max(
          0.05,
          orbitRef.current.distance * (1 + e.deltaY * ZOOM_FACTOR)
        );
        _applyCameraToThree();
        onCameraChangeRef.current?.({ ...orbitRef.current });
      };
      container.addEventListener("wheel", onWheelNative, { passive: false });

      import("three").then((THREE) => {
        if (cancelled || !container || !viewportHost) return;

        _applyViewportLayout();
        const { w: vw, h: vh } = sizeRef.current;

        const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setSize(vw, vh);
        renderer.setPixelRatio(Math.min(2, Math.max(1, window.devicePixelRatio)));
        renderer.setClearColor(0x1a1a1a);
        viewportHost.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const key = new THREE.DirectionalLight(0xffffff, 0.9);
        key.position.set(2, 4, 3);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0xffffff, 0.4);
        fill.position.set(-2, 1, -3);
        scene.add(fill);

        const grid = new THREE.GridHelper(4, 20, 0x444444, 0x333333);
        scene.add(grid);

        const geometry = new THREE.BufferGeometry();
        const material = new THREE.MeshStandardMaterial({
          color: 0xf2f2f2,
          roughness: 0.85,
          metalness: 0.0,
          side: THREE.DoubleSide,
          flatShading: false,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;
        scene.add(mesh);

        const boneGeometry = new THREE.BufferGeometry();
        const boneMaterial = new THREE.LineBasicMaterial({ color: 0x88ccff, linewidth: 2 });
        const boneLines = new THREE.LineSegments(boneGeometry, boneMaterial);
        boneLines.visible = false;
        scene.add(boneLines);

        const gizmoGroup = new THREE.Group();
        scene.add(gizmoGroup);

        const camera = new THREE.PerspectiveCamera(45, vw / vh, 0.01, 50);

        threeRef.current = {
          THREE,
          renderer,
          scene,
          camera,
          grid,
          mesh,
          geometry,
          boneLines,
          boneGeometry,
          gizmoGroup,
          gizmoPickables: [],
          animFrameId: 0,
        };
        _applyCameraToThree();
        if (pendingFacesRef.current) {
          _applyFaces(pendingFacesRef.current);
        }
        if (pendingFramingRef.current) {
          const { groundY, centerY } = pendingFramingRef.current;
          _applyFraming(groundY, centerY);
        }
        if (positionsRef.current && positionsRef.current.length >= 3) {
          const pos = positionsRef.current;
          geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(pos, 3)
          );
          geometry.computeVertexNormals();
          geometry.computeBoundingSphere();
          _applyVisibility();
        }
        if (gizmoKeyframesRef.current.length > 0) {
          _rebuildGizmos(gizmoKeyframesRef.current, centerYRef.current);
        }

        const ro = new ResizeObserver(() => {
          _applyViewportLayout();
        });
        ro.observe(container);
        resizeObsRef.current = ro;

        _updateOutputFrameOverlay();
        _updateCropOverlay();

        const animate = () => {
          if (cancelled) return;
          threeRef.current!.animFrameId = requestAnimationFrame(animate);
          renderer.render(scene, camera);
          _updateCropOverlay();
        };
        animate();
      });

      return () => {
        cancelled = true;
        container.removeEventListener("wheel", onWheelNative);
        if (resizeObsRef.current) {
          resizeObsRef.current.disconnect();
          resizeObsRef.current = null;
        }
        const t = threeRef.current;
        if (t) {
          cancelAnimationFrame(t.animFrameId);
          t.geometry.dispose();
          t.boneGeometry.dispose();
          for (const child of [...t.gizmoGroup.children]) {
            t.gizmoGroup.remove(child);
          }
          (t.mesh.material as import("three").Material).dispose();
          (t.boneLines.material as import("three").Material).dispose();
          t.renderer.dispose();
          if (viewportHost.contains(t.renderer.domElement)) {
            viewportHost.removeChild(t.renderer.domElement);
          }
        }
        threeRef.current = null;
      };
    }, []);

    useImperativeHandle(ref, () => ({
      setMode(mode: ViewerMode) {
        modeRef.current = mode;
        _applyVisibility();
      },
      setBonePairs(pairs: [number, number][]) {
        bonePairsRef.current = pairs;
      },
      setFaces(indices: Uint32Array) {
        _applyFaces(indices);
      },
      setFrame(positions: Float32Array) {
        if (pendingFacesRef.current) {
          _applyFaces(pendingFacesRef.current);
        }
        positionsRef.current = positions;
        const t = threeRef.current;
        if (!t) return;
        const geo = t.geometry;
        const existing = geo.getAttribute("position") as
          | import("three").BufferAttribute
          | undefined;
        if (!existing || existing.array.length !== positions.length) {
          geo.setAttribute("position", new t.THREE.BufferAttribute(positions, 3));
        } else {
          (existing.array as Float32Array).set(positions);
          existing.needsUpdate = true;
        }
        geo.computeVertexNormals();
        geo.computeBoundingSphere();
        _applyVisibility();
      },
      setJointFrame(positions: Float32Array) {
        positionsRef.current = positions;
        _updateBoneLines(positions);
      },
      setFraming(groundY: number, centerY: number) {
        _applyFraming(groundY, centerY);
      },
      getCameraState() {
        return { ...orbitRef.current };
      },
      setCameraState(
        state: Partial<CameraState> & Pick<CameraState, "azimuth" | "elevation">
      ) {
        orbitRef.current.azimuth = state.azimuth;
        orbitRef.current.elevation = state.elevation;
        if (state.distance != null && Number.isFinite(state.distance)) {
          orbitRef.current.distance = state.distance;
        }
        if (state.slideX != null && Number.isFinite(state.slideX)) {
          orbitRef.current.slideX = state.slideX;
        }
        if (state.slideY != null && Number.isFinite(state.slideY)) {
          orbitRef.current.slideY = state.slideY;
        }
        _applyCameraToThree();
        onCameraChange?.({ ...orbitRef.current });
      },
      setCameraGizmos(keyframes: CameraGizmoKeyframe[], centerY: number) {
        gizmoKeyframesRef.current = keyframes;
        _rebuildGizmos(keyframes, centerY);
      },
      setGizmosVisible(visible: boolean) {
        gizmosVisibleRef.current = visible;
        const t = threeRef.current;
        if (t) t.gizmoGroup.visible = visible;
      },
      getViewerCenterY() {
        return centerYRef.current;
      },
      getCameraWorldPose(): CameraWorldPose {
        const t = threeRef.current;
        if (!t) {
          const cy = centerYRef.current;
          return worldPoseFromOrbitState(orbitRef.current, cy);
        }
        const p = t.camera.position;
        const tgt = lastLookAtRef.current;
        return {
          position: [p.x, p.y, p.z],
          target: [tgt[0], tgt[1], tgt[2]],
        };
      },
      setCameraWorldPose(position: [number, number, number], target: [number, number, number]) {
        const t = threeRef.current;
        lastLookAtRef.current = target;
        if (!t) return;
        t.camera.position.set(position[0], position[1], position[2]);
        t.camera.lookAt(target[0], target[1], target[2]);
        orbitRef.current = orbitStateFromWorldPose(
          position,
          target,
          centerYRef.current,
        );
        onCameraChange?.({ ...orbitRef.current });
      },
      resetCamera() {
        orbitRef.current = { ...DEFAULT_ORBIT };
        _applyCameraToThree();
        onCameraChange?.({ ...DEFAULT_ORBIT });
      },
      resetAll() {
        orbitRef.current = { ...DEFAULT_ORBIT };
        modeRef.current = "mesh";
        bonePairsRef.current = [];
        positionsRef.current = null;
        const t = threeRef.current;
        if (t) {
          t.geometry.setAttribute(
            "position",
            new t.THREE.BufferAttribute(new Float32Array(0), 3)
          );
          t.boneGeometry.setAttribute(
            "position",
            new t.THREE.BufferAttribute(new Float32Array(0), 3)
          );
          _applyVisibility();
        }
        _applyCameraToThree();
        onCameraChange?.({ ...DEFAULT_ORBIT });
      },
      captureFrame() {
        const t = threeRef.current;
        if (!t) return null;
        try {
          const wasGizmoVisible = t.gizmoGroup.visible;
          t.gizmoGroup.visible = false;
          t.renderer.render(t.scene, t.camera);
          const dataUrl = t.renderer.domElement.toDataURL("image/png");
          t.gizmoGroup.visible = wasGizmoVisible && gizmosVisibleRef.current;
          return dataUrl;
        } catch {
          return null;
        }
      },
      captureFrameAutoFit(opts) {
        const t = threeRef.current;
        if (!t) return null;

        if (!positionsRef.current || positionsRef.current.length < 3) return null;

        const targetSize = opts?.targetSize ?? 1024;

        const { w: arW, h: arH } = aspectDimensionsForId(captureAspectRef.current);
        const captureW = arW >= arH ? targetSize : Math.round(targetSize * arW / arH);
        const captureH = arH >= arW ? targetSize : Math.round(targetSize * arH / arW);
        const captureAspRatio = captureW / captureH;

        const savedRendSize = new t.THREE.Vector2();
        t.renderer.getSize(savedRendSize);
        const savedAspect = t.camera.aspect;

        try {
          // ── Phase 1: full-frame render to get screenBbox ──────────────────
          // Render with the exact trajectory camera (no zoom, no pan) so the
          // figure position matches the mesh video perfectly.
          t.renderer.setSize(captureW, captureH);
          t.camera.aspect = captureAspRatio;
          t.camera.updateProjectionMatrix();

          const wasGizmoVisible = t.gizmoGroup.visible;
          t.gizmoGroup.visible = false;
          t.renderer.render(t.scene, t.camera);
          t.gizmoGroup.visible = wasGizmoVisible && gizmosVisibleRef.current;

          const screenBbox = _computeFigureScreenBbox();
          if (!screenBbox) return null;

          // ── Phase 2: HD closeup via tile projection matrix ────────────────
          // Switch to a square viewport so the closeup has 1:1 aspect for Qwen.
          t.renderer.setSize(targetSize, targetSize);
          t.camera.aspect = 1.0;
          t.camera.updateProjectionMatrix();

          // Compute where the figure sits in this 1:1 projection (vertex project
          // uses the current camera matrices — no render needed here).
          const closeupBbox = _computeFigureScreenBbox();
          if (!closeupBbox) return null;

          // Convert padded pixel bbox → NDC.  Y is flipped: screen top = NDC +1.
          const imgW = closeupBbox.imageWidth;
          const imgH = closeupBbox.imageHeight;
          const ndcL = (closeupBbox.x / imgW) * 2 - 1;
          const ndcR = ((closeupBbox.x + closeupBbox.width) / imgW) * 2 - 1;
          const ndcT = 1 - (closeupBbox.y / imgH) * 2;
          const ndcB = 1 - ((closeupBbox.y + closeupBbox.height) / imgH) * 2;

          // Tile matrix: maps the figure's NDC sub-region → [-1, 1] × [-1, 1].
          // Premultiplied onto projectionMatrix so the camera and geometry are
          // completely unchanged — only the frustum is narrowed around the figure.
          const scaleX = 2 / (ndcR - ndcL);
          const scaleY = 2 / (ndcT - ndcB);
          const transX = -(ndcR + ndcL) / (ndcR - ndcL);
          const transY = -(ndcT + ndcB) / (ndcT - ndcB);
          const tileMatrix = new t.THREE.Matrix4();
          // Matrix4.set() takes row-major order
          tileMatrix.set(
            scaleX, 0,      0, transX,
            0,      scaleY, 0, transY,
            0,      0,      1, 0,
            0,      0,      0, 1,
          );

          const savedProjMatrix = t.camera.projectionMatrix.clone();
          t.camera.projectionMatrix.premultiply(tileMatrix);

          t.gizmoGroup.visible = false;
          t.renderer.render(t.scene, t.camera);
          t.gizmoGroup.visible = wasGizmoVisible && gizmosVisibleRef.current;

          t.camera.projectionMatrix.copy(savedProjMatrix);

          const dataUrl = t.renderer.domElement.toDataURL('image/png');

          return {
            dataUrl,
            screenBbox: {
              x: screenBbox.x,
              y: screenBbox.y,
              width: screenBbox.width,
              height: screenBbox.height,
              imageWidth: screenBbox.imageWidth,
              imageHeight: screenBbox.imageHeight,
            },
          };
        } finally {
          t.renderer.setSize(savedRendSize.x, savedRendSize.y);
          t.camera.aspect = savedAspect;
          t.camera.updateProjectionMatrix();
        }
      },
      captureFrameAtAspect(opts) {
        const t = threeRef.current;
        if (!t) return null;

        const targetSize = opts?.targetSize ?? 1024;
        const { w: arW, h: arH } = aspectDimensionsForId(captureAspectRef.current);
        const captureW = arW >= arH ? targetSize : Math.round(targetSize * arW / arH);
        const captureH = arH >= arW ? targetSize : Math.round(targetSize * arH / arW);
        const captureAspRatio = captureW / captureH;

        const savedSize = new t.THREE.Vector2();
        t.renderer.getSize(savedSize);
        const savedAspect = t.camera.aspect;

        try {
          t.renderer.setSize(captureW, captureH);
          t.camera.aspect = captureAspRatio;
          t.camera.updateProjectionMatrix();
          _applyCameraToThree();

          const wasGizmoVisible = t.gizmoGroup.visible;
          t.gizmoGroup.visible = false;
          t.renderer.render(t.scene, t.camera);
          const dataUrl = t.renderer.domElement.toDataURL("image/png");
          t.gizmoGroup.visible = wasGizmoVisible && gizmosVisibleRef.current;

          const screenBbox = _computeFigureScreenBbox();
          return screenBbox ? { dataUrl, screenBbox } : null;
        } finally {
          t.renderer.setSize(savedSize.x, savedSize.y);
          t.camera.aspect = savedAspect;
          t.camera.updateProjectionMatrix();
          _applyCameraToThree();
        }
      },
      getFigureScreenBbox(): FigureScreenBbox | null {
        return _computeFigureScreenBbox();
      },
      setCropOverlayVisible(visible: boolean) {
        showCropOverlayRef.current = visible;
        _updateCropOverlay();
      },
      setOutputFrameOverlayVisible(visible: boolean) {
        showOutputFrameOverlayRef.current = visible;
        _updateOutputFrameOverlay();
      },
      setCaptureAspect(aspect: SequencePreviewAspect) {
        captureAspectRef.current = normalizeSequencePreviewAspect(aspect);
        _applyViewportLayout();
      },
    }));

    function onPointerDown(e: React.PointerEvent) {
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      const orbiting = e.shiftKey;
      pointerRef.current = {
        down: true,
        lastX: e.clientX,
        lastY: e.clientY,
        orbiting,
      };
      onUserCameraInteractRef.current?.(true);
      if (orbiting) {
        onUserOrbitChangeRef.current?.(true);
      }
    }
    function onPointerMove(e: React.PointerEvent) {
      const p = pointerRef.current;
      if (!p.down) return;
      const dx = e.clientX - p.lastX;
      const dy = e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      if (p.orbiting) {
        orbitRef.current.azimuth = (orbitRef.current.azimuth + dx * 0.5) % 360;
        orbitRef.current.elevation = Math.max(
          -89,
          Math.min(89, orbitRef.current.elevation - dy * 0.4)
        );
      } else {
        const vh = sizeRef.current.h || FALLBACK_H;
        const scale = (Math.max(0.05, orbitRef.current.distance) * TAN_HALF_FOV) / (vh * 0.5);
        orbitRef.current.slideX -= dx * scale;
        orbitRef.current.slideY += dy * scale;
      }
      _applyCameraToThree();
      onCameraChange?.({ ...orbitRef.current });
    }
    function onPointerUp(e: React.PointerEvent) {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      if (pointerRef.current.orbiting) {
        onUserOrbitChangeRef.current?.(false);
      }
      pointerRef.current.down = false;
      pointerRef.current.orbiting = false;
    }
    function onContextMenu(e: React.MouseEvent) {
      const id = _pickGizmo(e.clientX, e.clientY);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      onGizmoContextMenuRef.current?.(id, e.clientX, e.clientY);
    }

    return (
      <div
        ref={containerRef}
        style={{
          width,
          height,
          minWidth: 240,
          minHeight: 180,
          resize: "both",
          cursor: "grab",
          userSelect: "none",
          borderRadius: 2,
          overflow: "hidden",
          position: "relative",
          background: "#111",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={onContextMenu}
        title="Drag to slide view · Shift+drag to orbit · Scroll to zoom · Right-click camera gizmo to delete"
      >
        <div
          ref={outputFrameOverlayRef}
          style={{
            position: "absolute",
            display: "none",
            pointerEvents: "none",
            boxSizing: "border-box",
            border: "1px solid rgba(255, 255, 255, 0.9)",
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.18)",
            zIndex: 1,
          }}
        />
        <div
          ref={viewportHostRef}
          style={{
            position: "absolute",
            overflow: "hidden",
            zIndex: 0,
          }}
        >
          <div
            ref={cropOverlayRef}
            style={{
              position: "absolute",
              boxSizing: "border-box",
              border: "1px solid rgba(110,181,255,0.9)",
              pointerEvents: "none",
              display: "none",
              zIndex: 2,
            }}
          />
        </div>
      </div>
    );
  }
);

SkeletonViewer3D.displayName = "SkeletonViewer3D";
export { SkeletonViewer3D };
