import type React from "react";
import type {
  SequenceFrameItem,
  SequenceGalleryItem,
} from "../../lib/api";

export type SequenceWorkspaceGalleryItem = Pick<
  SequenceGalleryItem,
  "id" | "relPath" | "crop" | "frameSequence"
>;

export type SequenceGalleryPanelProps = {
  items: readonly SequenceWorkspaceGalleryItem[];
  selectedId: string | null;
  onFocus: () => void;
  onSelect: (id: string) => void;
  onItemContextMenu: (event: React.MouseEvent, index: number) => void;
  onItemDoubleClick?: (index: number) => void;
};

export type FrameTimelineCellView = Pick<
  SequenceFrameItem,
  "cellId" | "relPath" | "crop" | "sequenceGroupId" | "hidden"
>;

export type FrameTimelineGroupOutline = {
  groupId: string;
  min: number;
  max: number;
};

export type FrameTimelineViewportProps = {
  visibleFrameIndices: readonly number[];
  visibleOrdinals: readonly (number | null)[];
  cells: ReadonlyMap<number, FrameTimelineCellView>;
  selectedFrameIndices: ReadonlySet<number>;
  groupOutlines: readonly FrameTimelineGroupOutline[];
  logicalFps: number;
  ticksPerSecond: number;
  scale: number;
  onScaleChange: React.Dispatch<React.SetStateAction<number>>;
  onFocus: () => void;
  onCellClick: (event: React.MouseEvent, frameIndex: number) => void;
  onCellDoubleClick?: (frameIndex: number) => void;
  onCellContextMenu: (event: React.MouseEvent, frameIndex: number) => void;
};

export type SequenceWorkspaceShellProps = {
  open?: boolean;
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  zIndex?: number;
  closeLabel?: string;
};
