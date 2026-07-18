import type {
  FrameSequencePayload,
  TimelineClip,
  TimelineManifest,
} from "../../lib/api";

export function applyFrameSequencePayloads(
  manifest: TimelineManifest,
  payloads: Readonly<Record<string, FrameSequencePayload>>
): TimelineManifest {
  return {
    ...manifest,
    tracks: manifest.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        payloads[clip.id] ? { ...clip, frameSequence: payloads[clip.id] } : clip
      ),
    })),
  };
}

export type EncodedFrameSequenceReplacement = {
  clipId: string;
  strip: FrameSequencePayload;
  srcRelPath: string;
  alphaRelPath?: string;
  durationSec: number;
  width?: number;
  height?: number;
};

export function applyEncodedFrameSequenceReplacements(
  manifest: TimelineManifest,
  replacements: readonly EncodedFrameSequenceReplacement[]
): TimelineManifest {
  const byClipId = new Map(replacements.map((replacement) => [replacement.clipId, replacement]));
  return {
    ...manifest,
    tracks: manifest.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip): TimelineClip => {
        const replacement = byClipId.get(clip.id);
        if (!replacement) return clip;
        const {
          alphaRelPath: _dropAlpha,
          proxyRelPath: _dropProxy,
          proxyAlphaRelPath: _dropProxyAlpha,
          ...rest
        } = clip;
        return {
          ...rest,
          srcRelPath: replacement.srcRelPath,
          ...(replacement.alphaRelPath
            ? { alphaRelPath: replacement.alphaRelPath }
            : {}),
          inPoint: 0,
          outPoint: replacement.durationSec,
          duration: replacement.durationSec / Math.max(0.01, clip.speed),
          srcDuration: replacement.durationSec,
          naturalW: replacement.width || clip.naturalW,
          naturalH: replacement.height || clip.naturalH,
          frameSequence: replacement.strip,
          // Staging gallery is independent of encode/apply; keep it as-is.
          ...(clip.sequenceGallery ? { sequenceGallery: clip.sequenceGallery } : {}),
          frameEdit: {
            framesDirRel: clip.frameEdit?.framesDirRel ?? "",
            extractInPointSec: 0,
            extractFps: manifest.fps,
            mp4Aligned: true,
            ...(clip.frameEdit?.timelineViewStep === 2
              ? { timelineViewStep: 2 as const }
              : {}),
          },
        };
      }),
    })),
  };
}
