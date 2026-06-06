"use client";

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { SOMA_BONES_SIMPLIFIED, SOMA_PARENT, SOMA_REST_POSE } from "./soma_bones";

export type CameraState = {
  azimuth: number;   // degrees
  elevation: number; // degrees
  distance: number;  // world units (metres)
};

export type ViewerMode = "puppet" | "playback";

export type SkeletonViewer3DHandle = {
  /** Replace all visible joint positions (used for playback frame updates). */
  setFrame(joints: number[][]): void;
  /** Get current joint positions (puppet state or last playback frame). */
  getJoints(): number[][];
  /** Get current camera orbit state. */
  getCameraState(): CameraState;
  /** Switch between puppet (joint-drag) and playback (orbit-only) modes. */
  setPuppetMode(enabled: boolean): void;
  /** Restore T-pose without changing camera. */
  resetPose(): void;
  /** Restore T-pose AND reset camera to defaults. */
  resetAll(): void;
  /** Capture the current canvas as a PNG data URL. */
  captureFrame(): string | null;
};

type Props = {
  width?: number;
  height?: number;
  onCameraChange?: (state: CameraState) => void;
  /** Called whenever the user moves a joint in puppet mode. */
  onJointsChange?: (joints: number[][]) => void;
};

const DEFAULT_ORBIT = { azimuth: 20, elevation: 15, distance: 3 };

// ── Body segments for volume rendering (joint A, joint B, radius) ────────────
const BODY_SEGMENTS: [number, number, number][] = [
  [0,  3,  0.12],  // hips → chest (torso)
  [3,  6,  0.085], // chest → head (neck/upper torso)
  [12, 13, 0.05],  // left upper arm
  [13, 14, 0.045], // left forearm
  [40, 41, 0.05],  // right upper arm
  [41, 42, 0.045], // right forearm
  [67, 68, 0.06],  // left thigh
  [68, 69, 0.055], // left shin
  [72, 73, 0.06],  // right thigh
  [73, 74, 0.055], // right shin
];

// ── FK propagation (pure, no mutation) ──────────────────────────────────────

function buildChildList(parentArr: number[]): number[][] {
  const children: number[][] = parentArr.map(() => []);
  for (let i = 1; i < parentArr.length; i++) {
    const p = parentArr[i];
    if (p >= 0) children[p].push(i);
  }
  return children;
}

const _CHILD_LIST = buildChildList(SOMA_PARENT);

function propagateFK(
  joints: number[][],
  movedIdx: number,
  delta: [number, number, number]
): number[][] {
  const next = joints.map((j) => [...j]);
  const stack = [movedIdx];
  while (stack.length) {
    const idx = stack.pop()!;
    next[idx] = [
      next[idx][0] + delta[0],
      next[idx][1] + delta[1],
      next[idx][2] + delta[2],
    ];
    for (const child of _CHILD_LIST[idx] ?? []) stack.push(child);
  }
  return next;
}

// ── Component ────────────────────────────────────────────────────────────────

type ThreeModule = typeof import("three");

const SkeletonViewer3D = forwardRef<SkeletonViewer3DHandle, Props>(
  ({ width = 400, height = 300, onCameraChange, onJointsChange }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Three.js internals kept in refs (no re-renders).
    const threeRef = useRef<{
      THREE: ThreeModule;
      renderer: import("three").WebGLRenderer;
      scene: import("three").Scene;
      camera: import("three").PerspectiveCamera;
      raycaster: import("three").Raycaster;
      jointMeshes: import("three").Mesh[];
      jointNormalMat: import("three").MeshPhongMaterial;
      jointSelectedMat: import("three").MeshPhongMaterial;
      normalGeo: import("three").SphereGeometry;
      selectedGeo: import("three").SphereGeometry;
      headGeo: import("three").SphereGeometry;
      headMesh: import("three").Mesh;
      bodySegmentMeshes: import("three").Mesh[];
      bodyMat: import("three").MeshPhongMaterial;
      boneLines: import("three").Line[];
      animFrameId: number;
    } | null>(null);

    // Mutable puppet joint positions.
    const puppetJointsRef = useRef<number[][]>(
      SOMA_REST_POSE.map((p) => [...p])
    );

    // Camera orbit state.
    const orbitRef = useRef({ ...DEFAULT_ORBIT });

    // Pointer/drag state.
    const pointerRef = useRef<{
      down: boolean;
      dragMode: "none" | "orbit" | "joint";
      lastX: number;
      lastY: number;
      selectedIdx: number | null;
    }>({ down: false, dragMode: "none", lastX: 0, lastY: 0, selectedIdx: null });

    // Current viewer mode.
    const modeRef = useRef<ViewerMode>("puppet");

    // ── Camera helpers ───────────────────────────────────────────────────────

    function _applyCameraToThree() {
      const t = threeRef.current;
      if (!t) return;
      const { azimuth, elevation, distance } = orbitRef.current;
      const phi = (90 - elevation) * (Math.PI / 180);
      const theta = azimuth * (Math.PI / 180);
      t.camera.position.set(
        distance * Math.sin(phi) * Math.sin(theta),
        distance * Math.cos(phi),
        distance * Math.sin(phi) * Math.cos(theta)
      );
      t.camera.lookAt(0, 0.5, 0);
    }

    // ── Body segment update ──────────────────────────────────────────────────

    function _updateBodySegments(joints: number[][], THREE: ThreeModule, meshes: import("three").Mesh[]) {
      BODY_SEGMENTS.forEach(([ai, bi], idx) => {
        const mesh = meshes[idx];
        if (!mesh) return;
        const ja = joints[ai];
        const jb = joints[bi];
        if (!ja || !jb) { mesh.visible = false; return; }

        const ax = ja[0], ay = ja[1], az = ja[2];
        const bx = jb[0], by = jb[1], bz = jb[2];
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const mz = (az + bz) / 2;

        const dx = bx - ax, dy = by - ay, dz = bz - az;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) { mesh.visible = false; return; }

        mesh.position.set(mx, my, mz);
        mesh.scale.y = len;
        mesh.visible = true;

        // Align cylinder Y-axis to bone direction.
        const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
        const yAxis = new THREE.Vector3(0, 1, 0);
        const q = new THREE.Quaternion().setFromUnitVectors(yAxis, dir);
        mesh.quaternion.copy(q);
      });
    }

    // ── Skeleton rendering ───────────────────────────────────────────────────

    function _renderJoints(joints: number[][]) {
      const t = threeRef.current;
      if (!t) return;
      const selectedIdx = pointerRef.current.selectedIdx;

      for (let i = 0; i < joints.length && i < t.jointMeshes.length; i++) {
        const [x, y, z] = joints[i];
        const m = t.jointMeshes[i];
        m.position.set(x, y, z);
        m.visible = true;
        const isSel = i === selectedIdx;
        m.material = isSel ? t.jointSelectedMat : t.jointNormalMat;
        m.geometry = isSel ? t.selectedGeo : t.normalGeo;
      }
      for (let i = joints.length; i < t.jointMeshes.length; i++) {
        t.jointMeshes[i].visible = false;
      }

      // Update bones
      SOMA_BONES_SIMPLIFIED.forEach(([ci, pi], idx) => {
        const line = t.boneLines[idx];
        if (!line) return;
        const cj = joints[ci];
        const pj = joints[pi];
        if (!cj || !pj) { line.visible = false; return; }
        const pos = line.geometry.attributes.position as import("three").BufferAttribute;
        pos.setXYZ(0, pj[0], pj[1], pj[2]);
        pos.setXYZ(1, cj[0], cj[1], cj[2]);
        pos.needsUpdate = true;
        line.visible = true;
      });

      // Update body volume segments
      _updateBodySegments(joints, t.THREE, t.bodySegmentMeshes);

      // Update head sphere position
      const headJoint = joints[6];
      if (headJoint) {
        t.headMesh.position.set(headJoint[0], headJoint[1], headJoint[2]);
        t.headMesh.visible = true;
      }

      puppetJointsRef.current = joints;
    }

    // ── Three.js init ────────────────────────────────────────────────────────

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      let cancelled = false;

      import("three").then((THREE) => {
        if (cancelled || !container) return;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setClearColor(0x1a1a1a);
        container.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dir = new THREE.DirectionalLight(0xffffff, 0.8);
        dir.position.set(2, 4, 3);
        scene.add(dir);
        scene.add(new THREE.GridHelper(4, 20, 0x444444, 0x333333));

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 50);
        const raycaster = new THREE.Raycaster();
        raycaster.params.Mesh = { threshold: 0.04 };

        // Materials
        const jointNormalMat = new THREE.MeshPhongMaterial({ color: 0xff4444 });
        const jointSelectedMat = new THREE.MeshPhongMaterial({ color: 0xffd166 });
        const normalGeo = new THREE.SphereGeometry(0.025, 7, 5);
        const selectedGeo = new THREE.SphereGeometry(0.038, 7, 5);

        // Body material — semi-transparent skin tone
        const bodyMat = new THREE.MeshPhongMaterial({
          color: 0xf0c8a0,
          transparent: true,
          opacity: 0.72,
          shininess: 30,
        });

        // Head sphere
        const headGeo = new THREE.SphereGeometry(0.11, 10, 8);
        const headMesh = new THREE.Mesh(headGeo, bodyMat);
        headMesh.visible = false;
        scene.add(headMesh);

        // Body segment cylinders (radius from BODY_SEGMENTS, height=1 scaled per frame)
        const bodySegmentMeshes: import("three").Mesh[] = BODY_SEGMENTS.map(([, , radius]) => {
          const geo = new THREE.CylinderGeometry(radius, radius, 1, 10, 1);
          const mesh = new THREE.Mesh(geo, bodyMat);
          mesh.visible = false;
          scene.add(mesh);
          return mesh;
        });

        // Joint spheres (rendered on top for selection feedback)
        const jointMeshes: import("three").Mesh[] = [];
        for (let i = 0; i < 77; i++) {
          const m = new THREE.Mesh(normalGeo, jointNormalMat);
          m.visible = false;
          scene.add(m);
          jointMeshes.push(m);
        }

        // Bone lines
        const boneMat = new THREE.LineBasicMaterial({ color: 0x66aaff, linewidth: 2 });
        const boneLines: import("three").Line[] = SOMA_BONES_SIMPLIFIED.map(() => {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
          const line = new THREE.Line(geo, boneMat);
          line.visible = false;
          scene.add(line);
          return line;
        });

        threeRef.current = {
          THREE,
          renderer, scene, camera, raycaster,
          jointMeshes, jointNormalMat, jointSelectedMat, normalGeo, selectedGeo,
          headGeo, headMesh, bodySegmentMeshes, bodyMat,
          boneLines, animFrameId: 0,
        };

        _applyCameraToThree();
        _renderJoints(SOMA_REST_POSE.map((p) => [...p]));

        const animate = () => {
          if (cancelled) return;
          threeRef.current!.animFrameId = requestAnimationFrame(animate);
          renderer.render(scene, camera);
        };
        animate();
      });

      return () => {
        cancelled = true;
        const t = threeRef.current;
        if (t) {
          cancelAnimationFrame(t.animFrameId);
          t.renderer.dispose();
          if (container.contains(t.renderer.domElement)) {
            container.removeChild(t.renderer.domElement);
          }
        }
        threeRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Imperative handle ────────────────────────────────────────────────────

    useImperativeHandle(ref, () => ({
      setFrame(joints: number[][]) {
        _renderJoints(joints);
      },
      getJoints() {
        return puppetJointsRef.current.map((j) => [...j]);
      },
      getCameraState() {
        return { ...orbitRef.current };
      },
      setPuppetMode(enabled: boolean) {
        modeRef.current = enabled ? "puppet" : "playback";
        if (!enabled) {
          pointerRef.current.selectedIdx = null;
          _renderJoints(puppetJointsRef.current);
        }
      },
      resetPose() {
        const rest = SOMA_REST_POSE.map((p) => [...p]);
        pointerRef.current.selectedIdx = null;
        _renderJoints(rest);
        onJointsChange?.(rest);
      },
      resetAll() {
        orbitRef.current = { ...DEFAULT_ORBIT };
        _applyCameraToThree();
        onCameraChange?.({ ...DEFAULT_ORBIT });
        const rest = SOMA_REST_POSE.map((p) => [...p]);
        pointerRef.current.selectedIdx = null;
        _renderJoints(rest);
        onJointsChange?.(rest);
      },
      captureFrame() {
        const t = threeRef.current;
        if (!t) return null;
        try {
          return t.renderer.domElement.toDataURL("image/png");
        } catch {
          return null;
        }
      },
    }));

    // ── Pointer events ────────────────────────────────────────────────────────

    function _screenToNDC(clientX: number, clientY: number) {
      const container = containerRef.current;
      if (!container) return { x: 0, y: 0 };
      const rect = container.getBoundingClientRect();
      return {
        x: ((clientX - rect.left) / rect.width) * 2 - 1,
        y: -((clientY - rect.top) / rect.height) * 2 + 1,
      };
    }

    function onPointerDown(e: React.PointerEvent) {
      const t = threeRef.current;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);

      if (modeRef.current === "puppet" && t) {
        const ndc = _screenToNDC(e.clientX, e.clientY);
        t.raycaster.setFromCamera({ x: ndc.x, y: ndc.y }, t.camera);
        const hits = t.raycaster.intersectObjects(t.jointMeshes, false);
        if (hits.length > 0) {
          const hitMesh = hits[0].object as import("three").Mesh;
          const idx = t.jointMeshes.indexOf(hitMesh);
          pointerRef.current = {
            down: true, dragMode: "joint",
            lastX: e.clientX, lastY: e.clientY,
            selectedIdx: idx,
          };
          _renderJoints(puppetJointsRef.current);
          return;
        }
      }

      pointerRef.current = {
        down: true, dragMode: "orbit",
        lastX: e.clientX, lastY: e.clientY,
        selectedIdx: pointerRef.current.selectedIdx,
      };
    }

    function onPointerMove(e: React.PointerEvent) {
      const p = pointerRef.current;
      const t = threeRef.current;
      if (!p.down || !t) return;

      const dx = e.clientX - p.lastX;
      const dy = e.clientY - p.lastY;
      p.lastX = e.clientX;
      p.lastY = e.clientY;

      if (p.dragMode === "orbit") {
        orbitRef.current.azimuth = (orbitRef.current.azimuth + dx * 0.5) % 360;
        orbitRef.current.elevation = Math.max(
          -89, Math.min(89, orbitRef.current.elevation - dy * 0.4)
        );
        _applyCameraToThree();
        onCameraChange?.({ ...orbitRef.current });
        return;
      }

      if (p.dragMode === "joint" && p.selectedIdx !== null) {
        const jointPos = puppetJointsRef.current[p.selectedIdx];
        if (!jointPos) return;

        // Use the cached THREE module — avoids multiple-instances warning.
        const THREE = t.THREE;
        const cam = t.camera;
        const lookDir = cam.getWorldDirection(new THREE.Vector3());
        const worldUp = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(lookDir, worldUp).normalize();
        const up = new THREE.Vector3().crossVectors(right, lookDir).normalize();

        const jv = new THREE.Vector3(jointPos[0], jointPos[1], jointPos[2]);
        const distToCam = cam.position.distanceTo(jv);
        const fovY = (cam.fov * Math.PI) / 180;
        const pxToWorld = (2 * distToCam * Math.tan(fovY / 2)) / height;

        const worldDx = dx * pxToWorld;
        const worldDy = dy * pxToWorld;

        const delta: [number, number, number] = [
          right.x * worldDx - up.x * worldDy,
          right.y * worldDx - up.y * worldDy,
          right.z * worldDx - up.z * worldDy,
        ];

        const newJoints = propagateFK(puppetJointsRef.current, p.selectedIdx, delta);
        _renderJoints(newJoints);
        onJointsChange?.(newJoints);
      }
    }

    function onPointerUp(e: React.PointerEvent) {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      pointerRef.current.down = false;
      pointerRef.current.dragMode = "none";
    }

    function onWheel(e: React.WheelEvent) {
      orbitRef.current.distance = Math.max(
        0.5, Math.min(10, orbitRef.current.distance + e.deltaY * 0.005)
      );
      _applyCameraToThree();
      onCameraChange?.({ ...orbitRef.current });
    }

    const isPuppet = modeRef.current === "puppet";

    return (
      <div
        ref={containerRef}
        style={{
          width,
          height,
          cursor: isPuppet ? "crosshair" : "grab",
          userSelect: "none",
          borderRadius: 2,
          overflow: "hidden",
          position: "relative",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        title={
          isPuppet
            ? "Click a joint to select · Drag to move it and its children · Drag empty area to orbit"
            : "Drag to orbit · Scroll to zoom"
        }
      />
    );
  }
);

SkeletonViewer3D.displayName = "SkeletonViewer3D";
export { SkeletonViewer3D };
