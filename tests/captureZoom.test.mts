/**
 * Unit tests for motion-ref zoom crop helper (run: npx --yes tsx tests/captureZoom.test.mts)
 */
import assert from "node:assert/strict";
import {
  centroidInOutputAfterCropScale,
  computeViewOffsetFromBbox,
  mapPointThroughCropScale,
  physicalCropRect,
} from "../ui/frontend/src/components/motionRef/captureZoom.ts";

// Centered square bbox at 2× pixel ratio
{
  const { logicalBbox, viewOffset } = computeViewOffsetFromBbox(
    1024,
    576,
    { x: 448, y: 0, width: 1152, height: 1152, imageWidth: 2048, imageHeight: 1152 },
    2,
  );
  assert.equal(logicalBbox.x, 224);
  assert.equal(logicalBbox.y, 0);
  assert.equal(logicalBbox.width, 576);
  assert.equal(logicalBbox.height, 576);
  assert.equal(logicalBbox.imageWidth, 1024);
  assert.equal(logicalBbox.imageHeight, 576);
  assert.deepEqual(viewOffset, {
    fullWidth: 1024,
    fullHeight: 576,
    offsetX: 224,
    offsetY: 0,
    width: 576,
    height: 576,
  });
}

// Right-edge figure (physical pixels at 1×)
{
  const { logicalBbox, viewOffset } = computeViewOffsetFromBbox(
    1024,
    576,
    { x: 700, y: 80, width: 280, height: 280, imageWidth: 1024, imageHeight: 576 },
    1,
  );
  assert.equal(logicalBbox.x, 700);
  assert.equal(viewOffset.offsetX, 700);
  assert.equal(viewOffset.width, 280);
}

// pixelRatio fallback when zero
{
  const { logicalBbox } = computeViewOffsetFromBbox(
    1024,
    576,
    { x: 100, y: 50, width: 200, height: 200, imageWidth: 1024, imageHeight: 576 },
    0,
  );
  assert.equal(logicalBbox.x, 100);
  assert.equal(logicalBbox.y, 50);
}

// physicalCropRect passes through framebuffer coords unchanged
{
  const rect = physicalCropRect({
    x: 448,
    y: 0,
    width: 1152,
    height: 1152,
    imageWidth: 2048,
    imageHeight: 1152,
  });
  assert.deepEqual(rect, { sx: 448, sy: 0, sw: 1152, sh: 1152 });
}

// Centroid-centered crop maps centroid to output center after 2D crop+scale
{
  const cropSize = 576;
  const cropX = 224;
  const cropY = 0;
  const centroidX = cropX + cropSize / 2;
  const centroidY = cropY + cropSize / 2;
  const targetSize = 1024;
  const out = centroidInOutputAfterCropScale(
    cropX,
    cropY,
    cropSize,
    centroidX,
    centroidY,
    targetSize,
  );
  assert.equal(out.x, targetSize / 2);
  assert.equal(out.y, targetSize / 2);
}

// Off-center figure in crop shifts proportionally in output
{
  const cropX = 0;
  const cropY = 0;
  const cropSize = 576;
  const targetSize = 1024;
  const figureX = 400;
  const figureY = 300;
  const out = mapPointThroughCropScale(
    figureX,
    figureY,
    cropX,
    cropY,
    cropSize,
    targetSize,
  );
  const scale = targetSize / cropSize;
  assert.equal(out.x, figureX * scale);
  assert.equal(out.y, figureY * scale);
}

console.log("captureZoom.test.mts: all passed");
