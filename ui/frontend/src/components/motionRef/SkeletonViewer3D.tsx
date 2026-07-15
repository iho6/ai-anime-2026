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
const ZOOM_STEP = 0.12; // fixed 12% distance change per scroll notch regardless of deltaY magnitude
const FALLBACK_W = 380;
const FALLBACK_H = 320;
const FIGURE_CROP_PAD_FRAC = 0.08;
const FIGURE_CROP_PAD_MAX_PX = 80;
const MIN_PAN_DIST = 0.5; // pan speed floor — never slower than this effective distance
const MIN_CROP_SIZE = 64;


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

      // Single pass: accumulate 3D centroid sum and projected 2D AABB simultaneously.
      let sumX = 0, sumY = 0, sumZ = 0, count = 0;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        sumX += positions[i]; sumY += positions[i + 1]; sumZ += positions[i + 2];
        count++;
        vec.set(positions[i], positions[i + 1], positions[i + 2]);
        vec.project(camera);
        if (vec.z < -1 || vec.z > 1) continue;
        const px = (vec.x * 0.5 + 0.5) * imgW;
        const py = (-vec.y * 0.5 + 0.5) * imgH;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      if (!Number.isFinite(minX) || count === 0) return null;

      // Project 3D centroid for a stable crop center.
      // Computing the average in 3D before projecting avoids the perspective-induced
      // AABB drift that occurs when the near side of the body protrudes further in
      // screen space than the far side at oblique camera angles.
      vec.set(sumX / count, sumY / count, sumZ / count);
      vec.project(camera);
      let cx: number, cy: number;
      if (vec.z >= -1 && vec.z <= 1) {
        cx = (vec.x * 0.5 + 0.5) * imgW;
        cy = (-vec.y * 0.5 + 0.5) * imgH;
      } else {
        cx = (minX + maxX) / 2;
        cy = (minY + maxY) / 2;
      }

      // Square side from the farthest AABB vertex to the centroid, so the square
      // always contains every vertex even when the centroid is offset from the AABB center.
      // Using max(bw,bh)/2 would fail if the centroid is not at the AABB midpoint.
      const halfW = Math.max(cx - minX, maxX - cx);
      const halfH = Math.max(cy - minY, maxY - cy);
      const halfSide = Math.max(halfW, halfH, MIN_CROP_SIZE / 2);
      const padPx = Math.min(halfSide * FIGURE_CROP_PAD_FRAC, FIGURE_CROP_PAD_MAX_PX);
      const side = Math.round((halfSide + padPx) * 2);
      // nx = cx - side/2 guarantees the centroid projects to exactly 512/1024 in Phase 2.
      // Negative values are intentional: setViewOffset accepts them and renders those
      // out-of-canvas areas as the clear color (transparent), which is the verification feature.
      const nx = Math.round(cx - side / 2);
      const ny = Math.round(cy - side / 2);
      return { x: nx, y: ny, width: side, height: side, imageWidth: imgW, imageHeight: imgH };
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
        const direction = Math.sign(e.deltaY);
        if (direction === 0) return;
        onUserCameraInteractRef.current?.(true);
        orbitRef.current.distance = Math.max(
          0.05,
          orbitRef.current.distance * (1 + direction * ZOOM_STEP)
        );
        _applyCameraToThree();
        onCameraChangeRef.current?.({ ...orbitRef.current });
        onUserCameraInteractRef.current?.(false);
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
          t.grid.visible = false;
          t.renderer.render(t.scene, t.camera);
          const dataUrl = t.renderer.domElement.toDataURL("image/png");
          t.grid.visible = true;
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
          t.grid.visible = false;
          t.renderer.render(t.scene, t.camera);
          t.grid.visible = true;
          t.gizmoGroup.visible = wasGizmoVisible && gizmosVisibleRef.current;

          const screenBbox = _computeFigureScreenBbox();
          if (!screenBbox) return null;

          // ── Phase 2: 3D re-render via tile projection matrix ─────────────
          // Narrows the GPU frustum to the figure's bbox so the full 1024²
          // output is a real re-render at native 3D quality — not a 2D upscale.
          t.renderer.setSize(targetSize, targetSize);
          t.camera.aspect = 1.0;
          t.camera.updateProjectionMatrix();

          // Derive NDC tile bounds from Phase-1 physical-pixel bbox.
          // Horizontal NDC in the 16:9 camera spans [-captureAspRatio, +captureAspRatio];
          // mapping to the 1:1 camera's [-1, +1] requires the captureAspRatio scale.
          const imgW_p1 = screenBbox.imageWidth;   // captureW × pixelRatio
          const imgH_p1 = screenBbox.imageHeight;  // captureH × pixelRatio
          const ndcL = ((screenBbox.x / imgW_p1) * 2 - 1) * captureAspRatio;
          const ndcR = (((screenBbox.x + screenBbox.width)  / imgW_p1) * 2 - 1) * captureAspRatio;
          const ndcT =  1 - (screenBbox.y / imgH_p1) * 2;
          const ndcB =  1 - ((screenBbox.y + screenBbox.height) / imgH_p1) * 2;

          const scaleX =  2 / (ndcR - ndcL);
          const scaleY =  2 / (ndcT - ndcB);
          const transX = -(ndcR + ndcL) / (ndcR - ndcL);
          const transY = -(ndcT + ndcB) / (ndcT - ndcB);
          const tileMatrix = new t.THREE.Matrix4();
          tileMatrix.set(
            scaleX, 0,      0, transX,
            0,      scaleY, 0, transY,
            0,      0,      1, 0,
            0,      0,      0, 1,
          );

          const savedProjMatrix = t.camera.projectionMatrix.clone();
          t.camera.projectionMatrix.premultiply(tileMatrix);

          t.gizmoGroup.visible = false;
          t.grid.visible = false;
          t.renderer.render(t.scene, t.camera);
          t.grid.visible = true;
          t.gizmoGroup.visible = wasGizmoVisible && gizmosVisibleRef.current;

          t.camera.projectionMatrix.copy(savedProjMatrix);

          const dataUrl = t.renderer.domElement.toDataURL("image/png");

          // Normalize screenBbox to logical pixel space for cropBox metadata.
          const pr = t.renderer.getPixelRatio();
          return {
            dataUrl,
            screenBbox: {
              x: Math.round(screenBbox.x / pr),
              y: Math.round(screenBbox.y / pr),
              width:  Math.round(screenBbox.width  / pr),
              height: Math.round(screenBbox.height / pr),
              imageWidth:  captureW,
              imageHeight: captureH,
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
          t.grid.visible = false;
          t.renderer.render(t.scene, t.camera);
          const dataUrl = t.renderer.domElement.toDataURL("image/png");
          t.grid.visible = true;
          t.gizmoGroup.visible = wasGizmoVisible && gizmosVisibleRef.current;

          const rawBbox = _computeFigureScreenBbox();
          if (!rawBbox) return null;
          const pr2 = t.renderer.getPixelRatio();
          const screenBbox = {
            x: Math.round(rawBbox.x / pr2),
            y: Math.round(rawBbox.y / pr2),
            width: Math.round(rawBbox.width / pr2),
            height: Math.round(rawBbox.height / pr2),
            imageWidth: captureW,
            imageHeight: captureH,
          };
          return { dataUrl, screenBbox };
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
        const scale = (Math.max(MIN_PAN_DIST, orbitRef.current.distance) * TAN_HALF_FOV) / (vh * 0.5);
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
      onUserCameraInteractRef.current?.(false);
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
