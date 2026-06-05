import type {
  TimelineClip,
  TimelineManifest,
  TimelineTrack,
} from "../../lib/api";

let _idSeq = 0;
export function genId(prefix: string): string {
  _idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_idSeq}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Preview box aspect ratio (width / height). */
export function aspectRatio(previewAspect: TimelineManifest["previewAspect"]): number {
  switch (previewAspect) {
    case "4:3":
      return 4 / 3;
    case "1:1":
      return 1;
    case "9:16":
      return 9 / 16;
    case "16:9":
    default:
      return 16 / 9;
  }
}

/** End time (seconds) of a clip on the timeline. */
export function clipEnd(clip: TimelineClip): number {
  return clip.start + Math.max(0, clip.duration);
}

/** Total timeline duration across all tracks/clips (seconds). */
export function timelineDuration(manifest: TimelineManifest): number {
  let max = 0;
  for (const t of manifest.tracks) {
    for (const c of t.clips) {
      max = Math.max(max, clipEnd(c));
    }
  }
  return max;
}

/** The clip active at time ``t`` on a track (last one wins on overlap). */
export function activeClipAt(track: TimelineTrack, t: number): TimelineClip | null {
  let found: TimelineClip | null = null;
  for (const c of track.clips) {
    if (t >= c.start && t < clipEnd(c)) found = c;
  }
  return found;
}

/** Source-media time (seconds) for a video/audio clip at timeline time ``t``. */
export function sourceTimeAt(clip: TimelineClip, t: number): number {
  return clip.inPoint + (t - clip.start) * clip.speed;
}

export function formatTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec - Math.floor(sec)) * 100);
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function newVideoTrack(name: string): TimelineTrack {
  return { id: genId("trk"), name, kind: "video", clips: [] };
}

export function newAudioTrack(name: string): TimelineTrack {
  return { id: genId("trk"), name, kind: "audio", clips: [] };
}

/** Append a clip to a track, placed at the end of its existing clips. */
export function appendClipToTrack(track: TimelineTrack, clip: TimelineClip): TimelineTrack {
  let start = 0;
  for (const c of track.clips) start = Math.max(start, clipEnd(c));
  return { ...track, clips: [...track.clips, { ...clip, start }] };
}
