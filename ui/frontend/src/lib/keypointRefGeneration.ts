import type { KeypointVideoReference, PoseReference } from "./api";

export type KeypointRefEntry =
  | { kind: "single"; ref: PoseReference }
  | { kind: "video"; ref: KeypointVideoReference }
  | { kind: "folder"; folderId: string; folderName: string; keypoints: PoseReference[] };

export function keypointRefHasFrames(ref: KeypointRefEntry | null | undefined): boolean {
  if (!ref) return false;
  if (ref.kind === "single") return !!(ref.ref.keypointRelPath || "").trim();
  if (ref.kind === "folder") {
    return ref.keypoints.some((k) => (k.keypointRelPath || "").trim());
  }
  const strip = ref.ref.frameSequence?.strip ?? [];
  return strip.some((s) => s.kind === "image" && !s.hidden && (s.relPath || "").trim());
}

export function keypointRefFramePaths(ref: KeypointRefEntry | null | undefined): string[] {
  if (!ref) return [];
  if (ref.kind === "single") {
    const kp = (ref.ref.keypointRelPath || "").trim();
    return kp ? [kp] : [];
  }
  if (ref.kind === "folder") {
    return ref.keypoints
      .map((k) => (k.keypointRelPath || "").trim())
      .filter(Boolean);
  }
  const strip = ref.ref.frameSequence?.strip ?? [];
  return strip
    .filter((s) => s.kind === "image" && !s.hidden && (s.relPath || "").trim())
    .map((s) => String(s.relPath));
}

export function keypointRefPreviewFps(ref: KeypointRefEntry | null | undefined): number {
  if (!ref || ref.kind !== "video") return 24;
  return ref.ref.fps || 24;
}

export function keypointRefThumbPreview(ref: KeypointRefEntry | null | undefined): string | null {
  if (!ref) return null;
  if (ref.kind === "single") return ref.ref.referenceRelPath || ref.ref.keypointRelPath || null;
  if (ref.kind === "folder") {
    const first = ref.keypoints.find((k) => (k.referenceRelPath || k.keypointRelPath || "").trim());
    return first?.referenceRelPath || first?.keypointRelPath || null;
  }
  const strip = ref.ref.frameSequence?.strip ?? [];
  for (const s of strip) {
    if (s.kind !== "image") continue;
    const refRel = (s as { referenceRelPath?: string }).referenceRelPath;
    if (refRel) return refRel;
  }
  const paths = keypointRefFramePaths(ref);
  return paths[0] ?? null;
}
