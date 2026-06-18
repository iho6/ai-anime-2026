import type { CameraState } from "./SkeletonViewer3D";
import type { CameraKeyframe } from "../../lib/api";

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

function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function lerpAzimuth(a: number, b: number, t: number): number {
  let delta = ((b - a + 540) % 360) - 180;
  return a + delta * t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function interpolateCameraAtFrame(
  frame: number,
  keyframes: CameraKeyframe[],
): CameraState | null {
  if (keyframes.length === 0) return null;
  const sorted = [...keyframes].sort((a, b) => a.frameIndex - b.frameIndex);
  if (sorted.length === 1) {
    const k = sorted[0];
    return { azimuth: k.azimuth, elevation: k.elevation, distance: k.distance };
  }

  if (frame <= sorted[0].frameIndex) {
    const k = sorted[0];
    return { azimuth: k.azimuth, elevation: k.elevation, distance: k.distance };
  }
  const last = sorted[sorted.length - 1];
  if (frame >= last.frameIndex) {
    return { azimuth: last.azimuth, elevation: last.elevation, distance: last.distance };
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (frame >= a.frameIndex && frame <= b.frameIndex) {
      const span = b.frameIndex - a.frameIndex;
      const t = span > 0 ? smoothstep((frame - a.frameIndex) / span) : 0;
      return {
        azimuth: lerpAzimuth(a.azimuth, b.azimuth, t),
        elevation: lerp(a.elevation, b.elevation, t),
        distance: lerp(a.distance, b.distance, t),
      };
    }
  }

  return null;
}
