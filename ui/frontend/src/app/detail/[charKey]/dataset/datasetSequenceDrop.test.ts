import { describe, expect, it } from "vitest";
import type React from "react";
import { SEQUENCE_BUILDER_DRAG_MIME } from "./sequenceGalleryUtils";
import {
  parseSequenceBuilderDrop,
  setSequenceBuilderDragData,
} from "./datasetSequenceDrop";

function mockDragEvent(initial?: Record<string, string>): React.DragEvent {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    dataTransfer: {
      setData: (mime: string, value: string) => {
        store.set(mime, value);
      },
      getData: (mime: string) => store.get(mime) ?? "",
      effectAllowed: "",
    },
  } as unknown as React.DragEvent;
}

describe("sequence builder drag MIME", () => {
  it("round-trips relPath via setSequenceBuilderDragData and parseSequenceBuilderDrop", () => {
    const relPath = "characters/alice/pose/flat/a.png";
    const e = mockDragEvent();
    setSequenceBuilderDragData(e, relPath);
    expect(parseSequenceBuilderDrop(e)).toBe(relPath);
    expect(e.dataTransfer.effectAllowed).toBe("copy");
  });

  it("returns null for invalid JSON", () => {
    const e = mockDragEvent({
      [SEQUENCE_BUILDER_DRAG_MIME]: "not-json",
    });
    expect(parseSequenceBuilderDrop(e)).toBeNull();
  });

  it("returns null when relPath is missing or empty", () => {
    expect(
      parseSequenceBuilderDrop(
        mockDragEvent({ [SEQUENCE_BUILDER_DRAG_MIME]: JSON.stringify({}) })
      )
    ).toBeNull();
    expect(
      parseSequenceBuilderDrop(
        mockDragEvent({ [SEQUENCE_BUILDER_DRAG_MIME]: JSON.stringify({ relPath: "" }) })
      )
    ).toBeNull();
  });
});
