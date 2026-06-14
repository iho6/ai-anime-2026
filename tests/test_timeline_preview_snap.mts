/**
 * Unit tests for snapClipScaleToFrame (run: npx --yes tsx tests/test_timeline_preview_snap.mts)
 */
import assert from "node:assert/strict";
import {
  clipImageRect,
  snapClipScaleToFrame,
  type ClipTransform,
} from "../ui/frontend/src/components/timeline/timelineUtil.ts";
import type { TimelineClip } from "../ui/frontend/src/lib/api.ts";

function imageClip(nW: number, nH: number): TimelineClip {
  return {
    id: "c1",
    type: "image",
    start: 0,
    duration: 3,
    inPoint: 0,
    outPoint: 3,
    speed: 1,
    naturalW: nW,
    naturalH: nH,
    transform: { x: 0, y: 0, scale: 1 },
  };
}

const frameW = 1920;
const frameH = 1080;

// Left edge within snap threshold: scale snaps so left=0.
{
  const clip = imageClip(800, 600);
  const tf: ClipTransform = { x: 0, y: 0, scale: 1.328 };
  const before = clipImageRect(clip, tf, frameW, frameH);
  assert.ok(before.left > 0 && before.left < 8, `setup left=${before.left}`);
  const { scale, guides } = snapClipScaleToFrame(clip, tf, frameW, frameH);
  const rect = clipImageRect(clip, { ...tf, scale }, frameW, frameH);
  assert.ok(Math.abs(rect.left) < 0.01, `expected left≈0, got ${rect.left}`);
  assert.equal(guides.length, 1);
  assert.equal(guides[0]?.axis, "x");
  assert.equal(guides[0]?.pos, 0);
}

// Far from any edge: scale unchanged, no guides.
{
  const clip = imageClip(1920, 1080);
  const tf: ClipTransform = { x: 0, y: 0, scale: 1.2 };
  const { scale, guides } = snapClipScaleToFrame(clip, tf, frameW, frameH);
  assert.equal(scale, 1.2);
  assert.equal(guides.length, 0);
}

console.log("test_timeline_preview_snap: ok");
