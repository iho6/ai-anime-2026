/**
 * Unit tests for batchRefPreviewFramePaths (run: npx --yes tsx tests/batchRefPreview.test.mts)
 */
import assert from "node:assert/strict";
import { batchRefPreviewFramePaths } from "../ui/frontend/src/lib/batchRefPreview.ts";

const singles = [
  { kind: "single" as const, ref: { id: "a", keypointRelPath: "kp/a.png", referenceRelPath: "" } },
  { kind: "single" as const, ref: { id: "b", keypointRelPath: "kp/b.png", referenceRelPath: "" } },
];

assert.deepEqual(batchRefPreviewFramePaths(singles), ["kp/a.png", "kp/b.png"]);

const video = {
  kind: "video" as const,
  ref: {
    id: "v1",
    fps: 24,
    frameSequence: {
      strip: [
        { kind: "image" as const, relPath: "kp/v1_0.png", hidden: false },
        { kind: "image" as const, relPath: "kp/v1_1.png", hidden: false },
      ],
    },
  },
};

assert.deepEqual(batchRefPreviewFramePaths([singles[0], video]), [
  "kp/a.png",
  "kp/v1_0.png",
]);

assert.deepEqual(batchRefPreviewFramePaths([]), []);

console.log("batchRefPreview.test: ok");
