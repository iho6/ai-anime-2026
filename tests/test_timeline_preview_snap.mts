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

// Left edge within snap threshold: scale stays free; guide shown only.
{
  const clip = imageClip(800, 600);
  const tf: ClipTransform = { x: 0, y: 0, scale: 1.328 };
  const before = clipImageRect(clip, tf, frameW, frameH);
  assert.ok(before.left > 0 && before.left < 8, `setup left=${before.left}`);
  const { scale, guides } = snapClipScaleToFrame(clip, tf, frameW, frameH);
  assert.equal(scale, 1.328);
  assert.ok(guides.some((g) => g.axis === "x" && g.pos === 0));
}

// Scale past fill-width: can continue growing centered (no snap back to border).
{
  const clip = imageClip(800, 600);
  const tf: ClipTransform = { x: 0, y: 0, scale: 2.5 };
  const rect = clipImageRect(clip, tf, frameW, frameH);
  assert.ok(rect.left < 0, `expected left past border, got ${rect.left}`);
  const { scale } = snapClipScaleToFrame(clip, tf, frameW, frameH);
  assert.equal(scale, 2.5);
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
