import type { FrameSequenceStripSlot, TimelineClip } from "../../lib/api";
import { runTimelineExtractVideoFrameWsJob } from "../../lib/api";
import { stripSlotVisibleForExport } from "../frameSequenceStripUtils";
import { resolveClipImageRelPath } from "./timelineUtil";

export type FlfEndpointEdge = "start" | "end";

export function clipSupportsFlfEndpoint(clip: TimelineClip): boolean {
  return clip.type === "image" || clip.type === "video" || clip.type === "geometry";
}

export function selectedFlfClips(
  allClips: TimelineClip[],
  selectedIds: string[]
): TimelineClip[] {
  return selectedIds
    .map((id) => allClips.find((c) => c.id === id))
    .filter((c): c is TimelineClip => !!c && clipSupportsFlfEndpoint(c))
    .sort((a, b) => a.start - b.start);
}

/** First/last export-visible strip slot relPath, or null if none. */
export function flfStripEndpointRelPath(
  strip: FrameSequenceStripSlot[] | undefined,
  edge: FlfEndpointEdge
): string | null {
  if (!strip?.length) return null;
  const visible = strip.filter(stripSlotVisibleForExport);
  if (!visible.length) return null;
  const slot = edge === "start" ? visible[0]! : visible[visible.length - 1]!;
  const rel = slot.relPath?.trim();
  return rel || null;
}

export function flfEndpointLabel(clip: TimelineClip, edge: FlfEndpointEdge): string {
  if (clip.type === "image") return "Image";
  if (clip.type === "geometry") return "Geometry";
  return edge === "start" ? "Video first frame" : "Video last frame";
}

export async function resolveFlfEndpoint(
  timelineKey: string,
  clip: TimelineClip,
  edge: FlfEndpointEdge,
  onLogLine?: (line: string) => void
): Promise<string> {
  if (clip.type === "image") {
    return clip.srcRelPath;
  }
  if (clip.type === "geometry") {
    return resolveClipImageRelPath(timelineKey, clip);
  }
  if (clip.type === "video") {
    const fromStrip = flfStripEndpointRelPath(clip.frameSequence?.strip, edge);
    if (fromStrip) return fromStrip;
    const done = await runTimelineExtractVideoFrameWsJob({
      timelineKey,
      videoRelPath: clip.srcRelPath,
      inPoint: clip.inPoint ?? 0,
      outPoint: clip.outPoint ?? 0,
      edge: edge === "start" ? "first" : "last",
      onLogLine: onLogLine ?? (() => {}),
    });
    if (!done.ok || !done.result?.srcRelPath) {
      throw new Error(done.error || "Could not extract video frame for FLF.");
    }
    return done.result.srcRelPath;
  }
  throw new Error("Clip cannot be used as an FLF endpoint.");
}
