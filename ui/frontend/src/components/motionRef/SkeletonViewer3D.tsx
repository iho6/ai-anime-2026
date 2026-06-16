"use client";

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

export type CameraState = {
  azimuth: number;   // degrees
  elevation: number; // degrees
  distance: number;  // world units (metres)
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
  /** Restore orbit angles (distance unchanged). */
  setCameraState(state: Pick<CameraState, "azimuth" | "elevation">): void;
  /** Reset the camera to defaults and hide geometry. */
  resetAll(): void;
  /** Capture the current canvas as a PNG data URL. */
  captureFrame(): string | null;
  /** Screen-space figure AABB for crop placement (motion-ref keypoint pipeline). */
  getFigureScreenBbox(): FigureScreenBbox | null;
};

type Props = {
  width?: number | string;
  height?: number | string;
  onCameraChange?: (state: CameraState) => void;
};

const DEFAULT_ORBIT = { azimuth: 20, elevation: 15, distance: 2.6 };
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

type ThreeModule = typeof import("three");

const SkeletonViewer3D = forwardRef<SkeletonViewer3DHandle, Props>(
  ({ width = "100%", height = 320, onCameraChange }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);

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
      animFrameId: number;
    } | null>(null);

    const modeRef = useRef<ViewerMode>("mesh");
    const bonePairsRef = useRef<[number, number][]>([]);
    const positionsRef = useRef<Float32Array | null>(null);

    const orbitRef = useRef({ ...DEFAULT_ORBIT });
    const centerYRef = useRef(0.9);
    const sizeRef = useRef({
      w: typeof width === "number" ? width : FALLBACK_W,
      h: typeof height === "number" ? height : FALLBACK_H,
    });
    const resizeObsRef = useRef<ResizeObserver | null>(null);

    const onCameraChangeRef = useRef(onCameraChange);
    onCameraChangeRef.current = onCameraChange;

    const pointerRef = useRef({ down: false, lastX: 0, lastY: 0 });
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
      const { azimuth, elevation, distance } = orbitRef.current;
      const phi = (90 - elevation) * (Math.PI / 180);
      const theta = azimuth * (Math.PI / 180);
      const cy = centerYRef.current;
      t.camera.position.set(
        distance * Math.sin(phi) * Math.sin(theta),
        cy + distance * Math.cos(phi),
        distance * Math.sin(phi) * Math.cos(theta)
      );
      t.camera.lookAt(0, cy, 0);
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
      t.boneLines.visible = modeRef.current === "bones";
    }

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      let cancelled = false;

      const onWheelNative = (e: WheelEvent) => {
        e.preventDefault();
        orbitRef.current.distance = Math.max(
          0.5,
          Math.min(10, orbitRef.current.distance + e.deltaY * 0.005)
        );
        _applyCameraToThree();
        onCameraChangeRef.current?.({ ...orbitRef.current });
      };
      container.addEventListener("wheel", onWheelNative, { passive: false });

      import("three").then((THREE) => {
        if (cancelled || !container) return;

        const w0 = container.clientWidth || sizeRef.current.w || FALLBACK_W;
        const h0 = container.clientHeight || sizeRef.current.h || FALLBACK_H;
        sizeRef.current = { w: w0, h: h0 };

        const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setSize(w0, h0);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setClearColor(0x1a1a1a);
        container.appendChild(renderer.domElement);

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

        const camera = new THREE.PerspectiveCamera(45, w0 / h0, 0.01, 50);

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
          _applyVisibility();
        }

        const ro = new ResizeObserver(() => {
          const t = threeRef.current;
          if (!t) return;
          const w = container.clientWidth || sizeRef.current.w;
          const h = container.clientHeight || sizeRef.current.h;
          if (w < 1 || h < 1) return;
          sizeRef.current = { w, h };
          t.renderer.setSize(w, h);
          t.camera.aspect = w / h;
          t.camera.updateProjectionMatrix();
        });
        ro.observe(container);
        resizeObsRef.current = ro;

        const animate = () => {
          if (cancelled) return;
          threeRef.current!.animFrameId = requestAnimationFrame(animate);
          renderer.render(scene, camera);
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
          (t.mesh.material as import("three").Material).dispose();
          (t.boneLines.material as import("three").Material).dispose();
          t.renderer.dispose();
          if (container.contains(t.renderer.domElement)) {
            container.removeChild(t.renderer.domElement);
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
      setCameraState(state: Pick<CameraState, "azimuth" | "elevation">) {
        orbitRef.current.azimuth = state.azimuth;
        orbitRef.current.elevation = state.elevation;
        _applyCameraToThree();
        onCameraChange?.({ ...orbitRef.current });
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
          t.renderer.render(t.scene, t.camera);
          return t.renderer.domElement.toDataURL("image/png");
        } catch {
          return null;
        }
      },
      getFigureScreenBbox(): FigureScreenBbox | null {
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
        const box = padClampFigureBbox(minX, minY, maxX, maxY, imgW, imgH);
        return { ...box, imageWidth: imgW, imageHeight: imgH };
      },
    }));

    function onPointerDown(e: React.PointerEvent) {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      pointerRef.current = { down: true, lastX: e.clientX, lastY: e.clientY };
    }
    function onPointerMove(e: React.PointerEvent) {
      const p = pointerRef.current;
      if (!p.down) return;
      const dx = e.clientX - p.lastX;
      const dy = e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;
      orbitRef.current.azimuth = (orbitRef.current.azimuth + dx * 0.5) % 360;
      orbitRef.current.elevation = Math.max(-89, Math.min(89, orbitRef.current.elevation - dy * 0.4));
      _applyCameraToThree();
      onCameraChange?.({ ...orbitRef.current });
    }
    function onPointerUp(e: React.PointerEvent) {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      pointerRef.current.down = false;
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
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="Drag to orbit · Scroll to zoom · Drag corner to resize"
      />
    );
  }
);

SkeletonViewer3D.displayName = "SkeletonViewer3D";
export { SkeletonViewer3D };
