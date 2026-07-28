import { describe, expect, it } from "vitest";
import type { FrameSequencePayload } from "../lib/api";
import {
  frameSequenceHasExportableFrames,
  frameSequencePayloadEqual,
  planLinkedSequenceClipClose,
  planTimelineFrameSequenceFinish,
  planTimelineFrameSequenceGroupFinish,
  syncTrimHiddenToFrameSequence,
} from "./frameSequenceStripUtils";

function payload(strip: FrameSequencePayload["strip"]): FrameSequencePayload {
  return { sequenceGroupId: "sg1", strip, hidden: [] };
}

describe("frameSequenceHasExportableFrames", () => {
  it("returns false for an empty strip", () => {
    expect(frameSequenceHasExportableFrames(payload([]))).toBe(false);
  });

  it("returns false when strip has only hidden images", () => {
    expect(
      frameSequenceHasExportableFrames(
        payload([
          { kind: "image", relPath: "a.png", hidden: true },
          { kind: "empty" },
        ])
      )
    ).toBe(false);
  });

  it("returns true when at least one visible image exists", () => {
    expect(
      frameSequenceHasExportableFrames(
        payload([
          { kind: "empty" },
          { kind: "image", relPath: "frames/1.png" },
        ])
      )
    ).toBe(true);
  });
});

describe("planLinkedSequenceClipClose", () => {
  it("is noop when current equals snapshot", () => {
    const snap = payload([{ kind: "image", relPath: "a.png" }]);
    expect(planLinkedSequenceClipClose(snap, snap)).toEqual({ kind: "noop" });
    expect(
      planLinkedSequenceClipClose(payload([{ kind: "image", relPath: "a.png" }]), snap)
    ).toEqual({ kind: "noop" });
  });

  it("rematerializes when strip changed or snapshot missing", () => {
    const snap = payload([{ kind: "image", relPath: "a.png" }]);
    expect(
      planLinkedSequenceClipClose(
        payload([{ kind: "image", relPath: "a.png", hidden: true }]),
        snap
      )
    ).toEqual({ kind: "rematerialize" });
    expect(planLinkedSequenceClipClose(snap, undefined)).toEqual({ kind: "rematerialize" });
    expect(planLinkedSequenceClipClose(undefined, snap)).toEqual({ kind: "rematerialize" });
  });
});

describe("planTimelineFrameSequenceFinish", () => {
  it("is noop when payload equals initial", () => {
    const initial = payload([{ kind: "image", relPath: "a.png" }]);
    expect(planTimelineFrameSequenceFinish(initial, initial)).toEqual({ kind: "noop" });
    expect(
      planTimelineFrameSequenceFinish(
        payload([{ kind: "image", relPath: "a.png" }]),
        initial
      )
    ).toEqual({ kind: "noop" });
  });

  it("saves and applies when changed with exportable frames", () => {
    const initial = payload([{ kind: "image", relPath: "a.png" }]);
    const next = payload([
      { kind: "image", relPath: "a.png" },
      { kind: "empty" },
    ]);
    expect(planTimelineFrameSequenceFinish(next, initial)).toEqual({
      kind: "save",
      apply: true,
    });
  });

  it("saves without apply when changed but no exportable frames", () => {
    const initial = payload([{ kind: "image", relPath: "a.png" }]);
    const next = payload([{ kind: "image", relPath: "a.png", hidden: true }]);
    expect(planTimelineFrameSequenceFinish(next, initial)).toEqual({
      kind: "save",
      apply: false,
    });
  });
});

describe("planTimelineFrameSequenceGroupFinish", () => {
  it("is noop when every layer is unchanged", () => {
    const a = payload([{ kind: "image", relPath: "a.png" }]);
    const b = payload([{ kind: "image", relPath: "b.png" }]);
    expect(
      planTimelineFrameSequenceGroupFinish({ c1: a, c2: b }, { c1: a, c2: b })
    ).toEqual({ kind: "noop" });
  });

  it("saves and applies only changed exportable layers", () => {
    const a0 = payload([{ kind: "image", relPath: "a.png" }]);
    const a1 = payload([
      { kind: "image", relPath: "a.png" },
      { kind: "image", relPath: "a2.png" },
    ]);
    const b = payload([{ kind: "image", relPath: "b.png" }]);
    const plan = planTimelineFrameSequenceGroupFinish(
      { c1: a1, c2: b },
      { c1: a0, c2: b }
    );
    expect(plan).toEqual({
      kind: "save",
      applyPayloads: { c1: a1 },
    });
  });
});

describe("syncTrimHiddenToFrameSequence", () => {
  it("marks automatically hidden frames with trimHidden", () => {
    const synced = syncTrimHiddenToFrameSequence(
      payload([
        { kind: "image", relPath: "a.png" },
        { kind: "image", relPath: "b.png" },
        { kind: "image", relPath: "c.png" },
      ]),
      { inPoint: 1, outPoint: 2 },
      { framesDirRel: "frames", extractInPointSec: 0, extractFps: 1 },
      24
    );
    expect(synced.strip[0]).toMatchObject({ hidden: true, trimHidden: true });
    expect(synced.strip[1]).not.toHaveProperty("hidden");
    expect(synced.strip[2]).toMatchObject({ hidden: true, trimHidden: true });
  });

  it("clears only auto-hidden frames when trim moves back in range", () => {
    const synced = syncTrimHiddenToFrameSequence(
      payload([
        { kind: "image", relPath: "auto.png", hidden: true, trimHidden: true },
        { kind: "image", relPath: "manual.png", hidden: true },
      ]),
      { inPoint: 0, outPoint: 2 },
      { framesDirRel: "frames", extractInPointSec: 0, extractFps: 1 },
      24
    );
    expect(synced.strip[0]).toEqual({ kind: "image", relPath: "auto.png" });
    expect(synced.strip[1]).toEqual({
      kind: "image",
      relPath: "manual.png",
      hidden: true,
    });
  });

  it("keeps pre-existing manual hidden frames hidden outside the trim", () => {
    const synced = syncTrimHiddenToFrameSequence(
      payload([{ kind: "image", relPath: "manual.png", hidden: true }]),
      { inPoint: 1, outPoint: 2 },
      { framesDirRel: "frames", extractInPointSec: 0, extractFps: 1 },
      24
    );
    expect(synced.strip[0]).toEqual({
      kind: "image",
      relPath: "manual.png",
      hidden: true,
    });
  });
});

describe("frameSequencePayloadEqual", () => {
  const baseSlot = { kind: "image" as const, relPath: "a.png" };

  it("observes trimHidden", () => {
    expect(
      frameSequencePayloadEqual(payload([baseSlot]), payload([{ ...baseSlot, trimHidden: true }]))
    ).toBe(false);
  });

  it("observes placedFigure", () => {
    expect(
      frameSequencePayloadEqual(
        payload([baseSlot]),
        payload([{
          ...baseSlot,
          placedFigure: {
            canvas: { width: 100, height: 100 },
            placement: { x: 1, y: 2, width: 3, height: 4 },
          },
        }])
      )
    ).toBe(false);
  });

  it("observes sourceKeypointRelPath", () => {
    expect(
      frameSequencePayloadEqual(
        payload([baseSlot]),
        payload([{ ...baseSlot, sourceKeypointRelPath: "keypoints/a.json" }])
      )
    ).toBe(false);
  });
});
