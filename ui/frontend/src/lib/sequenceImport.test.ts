import { describe, expect, it } from "vitest";
import type { SequenceManifest } from "./api";
import { resolveSequenceImportGalleryItemId } from "./sequenceImport";

const emptyManifest: SequenceManifest = {
  version: 1,
  fps: 24,
  gallery: [],
  frames: [],
};

describe("resolveSequenceImportGalleryItemId", () => {
  it("returns undefined when timeline has exportable frames", () => {
    const manifest: SequenceManifest = {
      ...emptyManifest,
      frames: [{ index: 0, cellId: "c0", relPath: "characters/x/sequence/s/cells/a.png" }],
      gallery: [
        {
          id: "g1",
          relPath: "characters/x/sequence/s/gallery/cover.png",
          frameSequence: {
            sequenceGroupId: "sg1",
            strip: [{ kind: "image", relPath: "characters/x/sequence/s/gallery/f0.png" }],
            hidden: [],
          },
        },
      ],
    };
    expect(resolveSequenceImportGalleryItemId(manifest)).toBeUndefined();
  });

  it("returns first exportable gallery frameSequence id when timeline is empty", () => {
    const manifest: SequenceManifest = {
      ...emptyManifest,
      gallery: [
        {
          id: "g1",
          relPath: "characters/x/sequence/s/gallery/cover.png",
          frameSequence: {
            sequenceGroupId: "sg1",
            strip: [{ kind: "image", relPath: "characters/x/sequence/s/gallery/f0.png" }],
            hidden: [],
          },
        },
      ],
    };
    expect(resolveSequenceImportGalleryItemId(manifest)).toBe("g1");
  });

  it("skips hidden strip slots and empty kinds", () => {
    const manifest: SequenceManifest = {
      ...emptyManifest,
      gallery: [
        {
          id: "g-empty",
          relPath: "",
          frameSequence: {
            sequenceGroupId: "sg0",
            strip: [
              { kind: "empty" },
              { kind: "image", relPath: "x.png", hidden: true },
            ],
            hidden: [],
          },
        },
        {
          id: "g2",
          relPath: "cover.png",
          frameSequence: {
            sequenceGroupId: "sg2",
            strip: [{ kind: "image", relPath: "characters/x/f1.png" }],
            hidden: [],
          },
        },
      ],
    };
    expect(resolveSequenceImportGalleryItemId(manifest)).toBe("g2");
  });
});
