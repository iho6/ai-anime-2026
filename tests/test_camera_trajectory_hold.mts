import assert from "node:assert/strict";
import type { CameraKeyframe } from "../ui/frontend/src/lib/api.ts";
import { interpolateWorldPoseAtFrame, keyframeWorldPose } from "../ui/frontend/src/components/motionRef/cameraTrajectory.ts";

function kf(
  frameIndex: number,
  azimuth: number,
  holdFrames?: number,
  blendEase?: number,
): CameraKeyframe {
  return {
    id: `kf-${frameIndex}`,
    frameIndex,
    azimuth,
    elevation: 15,
    distance: 2.6,
    slideX: 0,
    slideY: 0,
    holdFrames,
    blendEase,
  };
}

function poseDist(
  a: { position: [number, number, number] },
  b: { position: [number, number, number] },
): number {
  return Math.hypot(
    a.position[0] - b.position[0],
    a.position[1] - b.position[1],
    a.position[2] - b.position[2],
  );
}

const centerY = 0.9;
const a = kf(0, 0, 0, 0);
const b = kf(100, 90, 0, 0);
const keyframesLinear = [a, b];

const pose0 = keyframeWorldPose(a, centerY);
const poseMidLinear = interpolateWorldPoseAtFrame(50, keyframesLinear, centerY)!;
assert.ok(poseDist(poseMidLinear, pose0) > 0.01, "mid-segment should blend without hold");

const poseEarlyLinear = interpolateWorldPoseAtFrame(1, keyframesLinear, centerY)!;
assert.ok(
  poseDist(poseEarlyLinear, pose0) > 0.001,
  "hold=0 ease=0 should move on first frame after keyframe",
);

const keyframesSmooth = [kf(0, 0, 0, 100), kf(100, 90, 0, 100)];
const poseEndSmooth = interpolateWorldPoseAtFrame(100, keyframesSmooth, centerY)!;
const poseB = keyframeWorldPose(b, centerY);
assert.ok(poseDist(poseEndSmooth, poseB) < 1e-6, "ease=100 should hit endpoint keyframe exactly");

// Interior keyframe: motion continues through the knot (no smoothstep pause).
const k0 = kf(0, 0, 0, 100);
const kMid = kf(50, 45, 0, 100);
const kEnd = kf(100, 90, 0, 100);
const keyframesThree = [k0, kMid, kEnd];
const poseMidExact = keyframeWorldPose(kMid, centerY);
const poseBeforeMid = interpolateWorldPoseAtFrame(49, keyframesThree, centerY)!;
const poseAfterMid = interpolateWorldPoseAtFrame(51, keyframesThree, centerY)!;
assert.ok(
  poseDist(poseBeforeMid, poseMidExact) > 0.001,
  "ease=100 should move through interior keyframe (frame before)",
);
assert.ok(
  poseDist(poseAfterMid, poseMidExact) > 0.001,
  "ease=100 should move through interior keyframe (frame after)",
);

const held = kf(0, 0, 10, 100);
const keyframesHold = [held, kf(100, 90, 0, 100)];
const poseDuringHold = interpolateWorldPoseAtFrame(5, keyframesHold, centerY)!;
const poseA = keyframeWorldPose(held, centerY);
assert.equal(poseDuringHold.position[0], poseA.position[0]);
assert.equal(poseDuringHold.position[1], poseA.position[1]);
assert.equal(poseDuringHold.position[2], poseA.position[2]);

const poseAfterHoldStart = interpolateWorldPoseAtFrame(10, keyframesHold, centerY)!;
assert.equal(poseAfterHoldStart.position[0], poseA.position[0]);

const poseAfterHoldBlend = interpolateWorldPoseAtFrame(11, keyframesHold, centerY)!;
assert.ok(
  poseDist(poseAfterHoldBlend, poseA) > 0.001,
  "should blend after hold window ends",
);

// At exact keyframe frame, interpolation must match stored keyframe pose (no double-apply drift).
const exactKf = kf(42, 35, 5, 50);
const exactPose = keyframeWorldPose(exactKf, centerY);
const interpolatedExact = interpolateWorldPoseAtFrame(42, [exactKf], centerY)!;
assert.equal(interpolatedExact.position[0], exactPose.position[0]);
assert.equal(interpolatedExact.position[1], exactPose.position[1]);
assert.equal(interpolatedExact.position[2], exactPose.position[2]);
assert.equal(interpolatedExact.target[0], exactPose.target[0]);
assert.equal(interpolatedExact.target[1], exactPose.target[1]);
assert.equal(interpolatedExact.target[2], exactPose.target[2]);

console.log("test_camera_trajectory_hold: OK");
