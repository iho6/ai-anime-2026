/**
 * Maps a continuous camera state (from the Three.js CameraWidget gizmo) to one of the
 * 96 discrete angle ids in services/prompts/camera_angles.json.
 *
 * Layout: id = distance_block*32 + elevation_block*8 + azimuth_index
 *   - azimuth_index: round(h/45) % 8  -> 0,45,...,315 buckets
 *   - elevation_block: low(<-15)=0, eye(<15)=1, elevated(<45)=2, high=3
 *   - distance_block: close=0, medium=1, wide=2  (camera "distance" 0..10; wide<2, medium<6, else close)
 *
 * Bucketing thresholds match the ComfyUI QwenMultiangleCameraNode (CameraWidget.generatePrompt /
 * nodes.py execute) so the gizmo selects the exact same discrete prompt the node would.
 */
export interface CameraState {
  azimuth: number;
  elevation: number;
  distance: number;
}

export function cameraStateToAngleId(s: CameraState): number {
  const az = Math.round((((s.azimuth % 360) + 360) % 360) / 45) % 8; // 0..7
  const el = s.elevation < -15 ? 0 : s.elevation < 15 ? 1 : s.elevation < 45 ? 2 : 3;
  const di = s.distance < 2 ? 2 : s.distance < 6 ? 1 : 0; // wide / medium / close
  return di * 32 + el * 8 + az;
}

const AZIMUTH_LABELS = [
  "Front",
  "Front-right",
  "Right side",
  "Back-right",
  "Back",
  "Back-left",
  "Left side",
  "Front-left",
];
const ELEVATION_LABELS = ["Low-angle", "Eye-level", "Elevated", "High-angle"];
const DISTANCE_LABELS = ["Close-up", "Medium shot", "Wide shot"];

/** Human-readable label for the currently-bucketed camera state (matches the picked angle id). */
export function cameraStateLabel(s: CameraState): string {
  const az = Math.round((((s.azimuth % 360) + 360) % 360) / 45) % 8;
  const el = s.elevation < -15 ? 0 : s.elevation < 15 ? 1 : s.elevation < 45 ? 2 : 3;
  const di = s.distance < 2 ? 2 : s.distance < 6 ? 1 : 0;
  return `${AZIMUTH_LABELS[az]} · ${ELEVATION_LABELS[el]} · ${DISTANCE_LABELS[di]}`;
}
