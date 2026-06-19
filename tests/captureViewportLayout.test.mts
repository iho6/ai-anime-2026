/**
 * Unit tests for motion-ref capture viewport layout (run: npx --yes tsx tests/captureViewportLayout.test.mts)
 */
import assert from "node:assert/strict";
import { computeCaptureViewportLayout, aspectIconBoxSize } from "../ui/frontend/src/components/motionRef/captureViewportLayout.ts";

// 16:9 in 800×600 — width-limited
{
  const r = computeCaptureViewportLayout(800, 600, "16:9");
  assert.equal(r.width, 800);
  assert.equal(r.height, 450);
  assert.equal(r.x, 0);
  assert.equal(r.y, 75);
}

// 9:16 in 800×600 — height-limited
{
  const r = computeCaptureViewportLayout(800, 600, "9:16");
  assert.equal(r.height, 600);
  assert.ok(Math.abs(r.width - 337.5) < 0.01);
  assert.ok(Math.abs(r.x - 231.25) < 0.01);
  assert.equal(r.y, 0);
}

// 1:1 in 800×600
{
  const r = computeCaptureViewportLayout(800, 600, "1:1");
  assert.equal(r.width, 600);
  assert.equal(r.height, 600);
  assert.equal(r.x, 100);
  assert.equal(r.y, 0);
}

// Wide container — 16:9 height-limited, centered horizontally
{
  const r = computeCaptureViewportLayout(1200, 400, "16:9");
  assert.ok(Math.abs(r.width - 711.111) < 0.1);
  assert.equal(r.height, 400);
  assert.ok(Math.abs(r.x - 244.444) < 0.1);
  assert.equal(r.y, 0);
}

// Tall container — 9:16 width-limited, centered vertically
{
  const r = computeCaptureViewportLayout(400, 900, "9:16");
  assert.equal(r.width, 400);
  assert.ok(Math.abs(r.height - 711.111) < 0.1);
  assert.equal(r.x, 0);
  assert.ok(Math.abs(r.y - 94.444) < 0.1);
}

// aspectIconBoxSize
{
  const r169 = aspectIconBoxSize(16, 9, 14);
  assert.equal(r169.width, 14);
  assert.ok(Math.abs(r169.height - 7.875) < 0.01);

  const r916 = aspectIconBoxSize(9, 16, 14);
  assert.ok(Math.abs(r916.width - 7.875) < 0.01);
  assert.equal(r916.height, 14);

  const r11 = aspectIconBoxSize(1, 1, 14);
  assert.equal(r11.width, 14);
  assert.equal(r11.height, 14);
}

console.log("captureViewportLayout.test.mts: all passed");
