import type { KeypointVideoReference, PoseReference } from "./api";
import type { KeypointRefEntry } from "./keypointRefGeneration";

export type BatchRefEntryLike = KeypointRefEntry;

/** First keypoint frame path per queued reference (for batch preview slideshow). */
export function batchRefPreviewFramePaths(queue: BatchRefEntryLike[]): string[] {
  const paths: string[] = [];
  for (const entry of queue) {
    if (entry.kind === "single") {
      const kp = (entry.ref.keypointRelPath || "").trim();
      if (kp) paths.push(kp);
      continue;
    }
    if (entry.kind === "folder") {
      for (const k of entry.keypoints) {
        const kp = (k.keypointRelPath || "").trim();
        if (kp) paths.push(kp);
      }
      continue;
    }
    const strip = entry.ref.frameSequence?.strip ?? [];
    const visible = strip.find(
      (s) => s.kind === "image" && !s.hidden && (s.relPath || "").trim()
    );
    const any = strip.find((s) => s.kind === "image" && (s.relPath || "").trim());
    const rel = visible?.relPath ?? any?.relPath;
    if (rel) paths.push(String(rel));
  }
  return paths;
}
