import type { CameraState } from "./SkeletonViewer3D";
import type { CameraKeyframe } from "../../lib/api";

const CENTER_Y_DEFAULT = 0.9;
export const DEFAULT_BLEND_EASE = 100;

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

export type CameraWorldPose = {
  position: [number, number, number];
  target: [number, number, number];
};

export function orbitPosition(
  azimuth: number,
  elevation: number,
  distance: number,
  centerY: number,
): [number, number, number] {
  const phi = (90 - elevation) * (Math.PI / 180);
  const theta = azimuth * (Math.PI / 180);
  return [
    distance * Math.sin(phi) * Math.sin(theta),
    centerY + distance * Math.cos(phi),
    distance * Math.sin(phi) * Math.cos(theta),
  ];
}

function linearT(frame: number, start: number, end: number): number {
  const span = end - start;
  if (span <= 0) return frame >= end ? 1 : 0;
  return Math.max(0, Math.min(1, (frame - start) / span));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function kfSlide(k: CameraKeyframe): { slideX: number; slideY: number } {
  return {
    slideX: Number.isFinite(k.slideX) ? k.slideX! : 0,
    slideY: Number.isFinite(k.slideY) ? k.slideY! : 0,
  };
}

function kfHold(k: CameraKeyframe): number {
  const h = k.holdFrames;
  if (h == null || !Number.isFinite(h)) return 0;
  return Math.max(0, Math.round(h));
}

function kfBlendEase(k: CameraKeyframe): number {
  const e = k.blendEase;
  if (e == null || !Number.isFinite(e)) return DEFAULT_BLEND_EASE;
  return Math.max(0, Math.min(100, Math.round(e)));
}

function easedT(tLin: number, easePct: number): number {
  const e = easePct / 100;
  if (e <= 0) return tLin;
  const s = smoothstep(tLin);
  return tLin + e * (s - tLin);
}

function vec3FromPose(
  v: number[] | undefined | null,
): [number, number, number] | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const a = Number(v[0]);
  const b = Number(v[1]);
  const c = Number(v[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
  return [a, b, c];
}

/** Match `_applyCameraToThree`: orbit + slide on camera position and look-at pivot. */
export function worldPoseFromOrbitState(
  state: Pick<CameraState, "azimuth" | "elevation" | "distance" | "slideX" | "slideY">,
  centerY: number,
): CameraWorldPose {
  const { azimuth, elevation, distance, slideX, slideY } = state;
  const [cx, cy, cz] = orbitPosition(azimuth, elevation, distance, centerY);
  const pivot: [number, number, number] = [0, centerY, 0];
  let fx = pivot[0] - cx;
  let fy = pivot[1] - cy;
  let fz = pivot[2] - cz;
  const flen = Math.hypot(fx, fy, fz) || 1;
  fx /= flen;
  fy /= flen;
  fz /= flen;
  let rx = fz;
  let ry = 0;
  let rz = -fx;
  const rlen = Math.hypot(rx, ry, rz);
  if (rlen < 1e-8) {
    rx = 1;
    ry = 0;
    rz = 0;
  } else {
    rx /= rlen;
    ry /= rlen;
    rz /= rlen;
  }
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;
  return {
    position: [
      cx + rx * slideX + ux * slideY,
      cy + ry * slideX + uy * slideY,
      cz + rz * slideX + uz * slideY,
    ],
    target: [
      pivot[0] + rx * slideX + ux * slideY,
      pivot[1] + ry * slideX + uy * slideY,
      pivot[2] + rz * slideX + uz * slideY,
    ],
  };
}

export function keyframeWorldPose(kf: CameraKeyframe, centerY: number): CameraWorldPose {
  const pos = vec3FromPose(kf.cameraPosition);
  const target = vec3FromPose(kf.lookAtTarget);
  if (pos && target) {
    return { position: pos, target };
  }
  const { slideX, slideY } = kfSlide(kf);
  return worldPoseFromOrbitState(
    {
      azimuth: kf.azimuth,
      elevation: kf.elevation,
      distance: kf.distance,
      slideX,
      slideY,
    },
    centerY,
  );
}

export function interpolateWorldPoseAtFrame(
  frame: number,
  keyframes: CameraKeyframe[],
  centerY: number = CENTER_Y_DEFAULT,
): CameraWorldPose | null {
  if (keyframes.length === 0) return null;
  const sorted = [...keyframes].sort((a, b) => a.frameIndex - b.frameIndex);
  if (sorted.length === 1) {
    return keyframeWorldPose(sorted[0], centerY);
  }
  if (frame <= sorted[0].frameIndex) {
    return keyframeWorldPose(sorted[0], centerY);
  }
  const last = sorted[sorted.length - 1];
  if (frame >= last.frameIndex) {
    return keyframeWorldPose(last, centerY);
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (frame >= a.frameIndex && frame <= b.frameIndex) {
      const hold = kfHold(a);
      const pa = keyframeWorldPose(a, centerY);
      if (hold > 0 && frame < a.frameIndex + hold) {
        return pa;
      }
      const blendStart = a.frameIndex + hold;
      if (blendStart >= b.frameIndex) {
        return keyframeWorldPose(b, centerY);
      }
      const tLin = linearT(frame, blendStart, b.frameIndex);
      const t = easedT(tLin, kfBlendEase(a));
      const pb = keyframeWorldPose(b, centerY);
      return {
        position: [
          lerp(pa.position[0], pb.position[0], t),
          lerp(pa.position[1], pb.position[1], t),
          lerp(pa.position[2], pb.position[2], t),
        ],
        target: [
          lerp(pa.target[0], pb.target[0], t),
          lerp(pa.target[1], pb.target[1], t),
          lerp(pa.target[2], pb.target[2], t),
        ],
      };
    }
  }
  return null;
}

/** @deprecated Use interpolateWorldPoseAtFrame + setCameraWorldPose */
export function interpolateCameraAtFrame(
  frame: number,
  keyframes: CameraKeyframe[],
  centerY: number = CENTER_Y_DEFAULT,
): CameraState | null {
  const pose = interpolateWorldPoseAtFrame(frame, keyframes, centerY);
  if (!pose) return null;
  return orbitStateFromWorldPose(pose.position, pose.target, centerY);
}

function orbitFromPosition(
  x: number,
  y: number,
  z: number,
  centerY: number,
): Pick<CameraState, "azimuth" | "elevation" | "distance"> {
  const dy = y - centerY;
  const distance = Math.hypot(x, dy, z);
  if (distance < 1e-6) {
    return { azimuth: 0, elevation: 15, distance: 3 };
  }
  const phi = Math.acos(Math.max(-1, Math.min(1, dy / distance)));
  const elevation = 90 - (phi * 180) / Math.PI;
  const theta = Math.atan2(x, z);
  const azimuth = (theta * 180) / Math.PI;
  return { azimuth, elevation, distance };
}

/** Inverse of worldPoseFromOrbitState for syncing orbitRef after setCameraWorldPose. */
export function orbitStateFromWorldPose(
  position: [number, number, number],
  target: [number, number, number],
  centerY: number,
): CameraState {
  const pivot: [number, number, number] = [0, centerY, 0];
  let fx = target[0] - position[0];
  let fy = target[1] - position[1];
  let fz = target[2] - position[2];
  const flen = Math.hypot(fx, fy, fz) || 1;
  fx /= flen;
  fy /= flen;
  fz /= flen;
  let rx = fz;
  let ry = 0;
  let rz = -fx;
  const rlen = Math.hypot(rx, ry, rz);
  if (rlen < 1e-8) {
    rx = 1;
    ry = 0;
    rz = 0;
  } else {
    rx /= rlen;
    ry /= rlen;
    rz /= rlen;
  }
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;
  const slideX =
    (target[0] - pivot[0]) * rx +
    (target[1] - pivot[1]) * ry +
    (target[2] - pivot[2]) * rz;
  const slideY =
    (target[0] - pivot[0]) * ux +
    (target[1] - pivot[1]) * uy +
    (target[2] - pivot[2]) * uz;
  const baseX = position[0] - rx * slideX - ux * slideY;
  const baseY = position[1] - ry * slideX - uy * slideY;
  const baseZ = position[2] - rz * slideX - uz * slideY;
  const orbit = orbitFromPosition(baseX, baseY, baseZ, centerY);
  return { ...orbit, slideX, slideY };
}
