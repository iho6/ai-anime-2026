import type { TimelineClip, TimelineTrack } from "../../lib/api";
import {
  activeClipAt,
  activeLayersAt,
  clamp,
  sourceTimeAt,
  sourceTimeAtWithTransition,
} from "./timelineUtil";
import { volumeGainAt } from "./volumeAutomation";

export type PreviewAudioOutput = {
  clip: TimelineClip;
  track: TimelineTrack;
  sourceTime: number;
  gain: number;
  sourceKind: "audio-track" | "video";
};

/**
 * Collect the media sources that should emit sound at the current playhead.
 * Visual video elements stay muted; video sound is emitted by a dedicated
 * audio element so transition/render duplicates cannot echo.
 */
export function previewAudioOutputsAt(
  tracks: TimelineTrack[],
  playhead: number
): PreviewAudioOutput[] {
  const outputs = new Map<string, PreviewAudioOutput>();

  for (const track of tracks) {
    if (track.hidden) continue;

    if (track.kind === "audio") {
      const clip = activeClipAt(track, playhead);
      if (!clip || clip.type !== "audio" || !clip.srcRelPath) continue;
      outputs.set(clip.id, {
        clip,
        track,
        sourceTime: sourceTimeAt(clip, playhead),
        // Full 0..2 range: the WebAudio sink supports boosts (crescendo,
        // normalization); the el.volume fallback clamps to 1 at the sink.
        gain: clamp(volumeGainAt(clip, playhead), 0, 2),
        sourceKind: "audio-track",
      });
      continue;
    }

    if (track.kind !== "video") continue;
    for (const layer of activeLayersAt(track, playhead)) {
      const clip = layer.clip;
      if (clip.type !== "video" || !clip.srcRelPath || layer.opacity <= 0.001) {
        continue;
      }
      const gain = clamp(layer.opacity, 0, 1);
      const existing = outputs.get(clip.id);
      if (existing && existing.gain >= gain) continue;
      outputs.set(clip.id, {
        clip,
        track,
        sourceTime: sourceTimeAtWithTransition(clip, playhead, track),
        gain,
        sourceKind: "video",
      });
    }
  }

  return [...outputs.values()];
}
