import { describe, expect, it } from "vitest";
import type { ReferencePickerSelection } from "../components/ReferencePicker";
import type { KeypointFolder, KeypointVideoReference, PoseReference } from "./api";
import {
  buildKeypointRefQueueFromSelection,
  pickSingleKeypointRefFromSelection,
  selectionHasUsableRefs,
} from "./referencePickerSelection";

function pose(id: string): PoseReference {
  return {
    id,
    referenceRelPath: `references/keypoints/ref_${id}.png`,
    keypointRelPath: `references/keypoints/kp_${id}.png`,
  };
}

function video(id: string): KeypointVideoReference {
  return {
    id,
    videoRelPath: `references/keypoints_video/${id}/source.mp4`,
    fps: 24,
    frameSequence: { sequenceGroupId: "sg", strip: [], hidden: [] },
  };
}

function folder(id: string, name: string, keypoints: PoseReference[]): ReferencePickerSelection["folders"][0] {
  return {
    folder: { id, name } as KeypointFolder,
    keypoints,
  };
}

describe("selectionHasUsableRefs", () => {
  it("returns false for empty selection", () => {
    expect(selectionHasUsableRefs({ singles: [], videos: [], folders: [] })).toBe(false);
  });

  it("returns true when folders present", () => {
    expect(
      selectionHasUsableRefs({
        singles: [],
        videos: [],
        folders: [folder("f1", "Folder", [pose("a")])],
      })
    ).toBe(true);
  });
});

describe("buildKeypointRefQueueFromSelection", () => {
  it("orders folders then singles then videos", () => {
    const sel: ReferencePickerSelection = {
      folders: [folder("f1", "F", [pose("a")])],
      singles: [pose("b")],
      videos: [video("v1")],
    };
    const queue = buildKeypointRefQueueFromSelection(sel);
    expect(queue.map((e) => e.kind)).toEqual(["folder", "single", "video"]);
  });
});

describe("pickSingleKeypointRefFromSelection", () => {
  it("picks video when only one video selected", () => {
    const ref = pickSingleKeypointRefFromSelection({
      singles: [],
      videos: [video("v1")],
      folders: [],
    });
    expect(ref?.kind).toBe("video");
  });

  it("picks folder when only one folder selected", () => {
    const ref = pickSingleKeypointRefFromSelection({
      singles: [],
      videos: [],
      folders: [folder("f1", "F", [pose("a"), pose("b")])],
    });
    expect(ref?.kind).toBe("folder");
    if (ref?.kind === "folder") {
      expect(ref.folderId).toBe("f1");
      expect(ref.keypoints).toHaveLength(2);
    }
  });

  it("picks first single when only singles selected", () => {
    const ref = pickSingleKeypointRefFromSelection({
      singles: [pose("a"), pose("b")],
      videos: [],
      folders: [],
    });
    expect(ref?.kind).toBe("single");
    if (ref?.kind === "single") expect(ref.ref.id).toBe("a");
  });

  it("returns null for empty selection", () => {
    expect(
      pickSingleKeypointRefFromSelection({ singles: [], videos: [], folders: [] })
    ).toBeNull();
  });

  it("returns null when mixing types", () => {
    expect(
      pickSingleKeypointRefFromSelection({
        singles: [pose("a")],
        videos: [video("v1")],
        folders: [],
      })
    ).toBeNull();
  });
});
