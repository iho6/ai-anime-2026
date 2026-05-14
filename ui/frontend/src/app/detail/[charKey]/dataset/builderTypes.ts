export type BuilderEntry = {
  tileId: string;
  sourceKind: "pose" | "expr";
  folderKey: string;
  sourceRelPath: string;
  previewRelPath: string | null;
  beforeNoiseRelPath: string | null;
  /** Dataset page only (grey mask, excluded from preview/select-all). Not pose/expression gallery hide. */
  builderHidden: boolean;
  removed: boolean;
};
