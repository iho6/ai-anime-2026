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

export type SkeletonViewer3DHandle = {
  /** Set the static SMPL-X face index buffer (flat triples). Call once per mesh. */
  setFaces(indices: Uint32Array): void;
  /** Update the mesh to a frame's vertex positions (flat Float32Array, length V*3). */
  setFrame(positions: Float32Array): void;
  /** Fix the ground plane + camera target for the whole motion (call once after load). */
  setFraming(groundY: number, centerY: number): void;
  /** Get current camera orbit state. */
  getCameraState(): CameraState;
  /** Reset the camera to defaults (mesh geometry is unchanged). */
  resetAll(): void;
  /** Capture the current canvas as a PNG data URL. */
  captureFrame(): string | null;
};

type Props = {
  width?: number | string;
  height?: number | string;
  onCameraChange?: (state: CameraState) => void;
};

const DEFAULT_ORBIT = { azimuth: 20, elevation: 15, distance: 2.6 };
const FALLBACK_W = 380;
const FALLBACK_H = 320;

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
      animFrameId: number;
    } | null>(null);

    const orbitRef = useRef({ ...DEFAULT_ORBIT });
    // Vertical center of the current mesh (camera target / framing).
    const centerYRef = useRef(0.9);
    const sizeRef = useRef({
      w: typeof width === "number" ? width : FALLBACK_W,
      h: typeof height === "number" ? height : FALLBACK_H,
    });
    const resizeObsRef = useRef<ResizeObserver | null>(null);

    // Latest onCameraChange (read by the native wheel listener without re-binding).
    const onCameraChangeRef = useRef(onCameraChange);
    onCameraChangeRef.current = onCameraChange;

    // Pointer orbit state.
    const pointerRef = useRef({ down: false, lastX: 0, lastY: 0 });

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

    // ── Three.js init ────────────────────────────────────────────────────────
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      let cancelled = false;

      // Non-passive wheel listener so zoom doesn't also scroll the modal/page.
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

        // White body mesh (geometry filled in by setFaces/setFrame).
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

        const camera = new THREE.PerspectiveCamera(45, w0 / h0, 0.01, 50);

        threeRef.current = { THREE, renderer, scene, camera, grid, mesh, geometry, animFrameId: 0 };
        _applyCameraToThree();

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
          (t.mesh.material as import("three").Material).dispose();
          t.renderer.dispose();
          if (container.contains(t.renderer.domElement)) {
            container.removeChild(t.renderer.domElement);
          }
        }
        threeRef.current = null;
      };
    }, []);

    // ── Imperative handle ────────────────────────────────────────────────────
    useImperativeHandle(ref, () => ({
      setFaces(indices: Uint32Array) {
        const t = threeRef.current;
        if (!t) return;
        t.geometry.setIndex(new t.THREE.BufferAttribute(indices, 1));
      },
      setFrame(positions: Float32Array) {
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
        t.mesh.visible = true;
      },
      setFraming(groundY: number, centerY: number) {
        const t = threeRef.current;
        if (!t) return;
        // Stable ground for the whole motion (no per-frame bobbing).
        t.grid.position.y = groundY;
        centerYRef.current = centerY;
        _applyCameraToThree();
      },
      getCameraState() {
        return { ...orbitRef.current };
      },
      resetAll() {
        orbitRef.current = { ...DEFAULT_ORBIT };
        _applyCameraToThree();
        onCameraChange?.({ ...DEFAULT_ORBIT });
      },
      captureFrame() {
        const t = threeRef.current;
        if (!t) return null;
        try {
          // Force a render so the buffer is current before reading it back.
          t.renderer.render(t.scene, t.camera);
          return t.renderer.domElement.toDataURL("image/png");
        } catch {
          return null;
        }
      },
    }));

    // ── Pointer events (orbit + zoom only) ────────────────────────────────────
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
