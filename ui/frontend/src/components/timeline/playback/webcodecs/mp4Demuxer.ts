/**
 * mp4box.js wrapper: fetch a (small, short-GOP) proxy MP4, index every video
 * sample, and expose EncodedVideoChunk data + a WebCodecs decoder config.
 *
 * Proxies are ~480p H.264 with GOP 12, so whole-file demux is cheap; sample
 * payloads stay in one ArrayBuffer owned by mp4box.
 */

import * as MP4Box from "mp4box";
import { type DemuxedSampleMeta } from "./gop";

/** Narrow view of the mp4box API we rely on (bundled types are opaque). */
type Mp4BoxSample = {
  number: number;
  track_id: number;
  is_sync: boolean;
  cts: number;
  dts: number;
  duration: number;
  timescale: number;
  data: Uint8Array;
};

type Mp4BoxVideoTrack = {
  id: number;
  codec: string;
  timescale: number;
  duration: number;
  nb_samples: number;
  video?: { width: number; height: number };
  track_width: number;
  track_height: number;
};

type Mp4BoxInfo = {
  videoTracks: Mp4BoxVideoTrack[];
};

type Mp4BoxFile = {
  onReady: ((info: Mp4BoxInfo) => void) | null;
  onError: ((module: string, message: string) => void) | null;
  onSamples:
    | ((trackId: number, user: unknown, samples: Mp4BoxSample[]) => void)
    | null;
  appendBuffer: (buffer: ArrayBuffer & { fileStart?: number }) => number;
  flush: () => void;
  setExtractionOptions: (
    trackId: number,
    user?: unknown,
    options?: { nbSamples?: number }
  ) => void;
  start: () => void;
  stop: () => void;
  getTrackById: (trackId: number) => {
    mdia?: {
      minf?: {
        stbl?: {
          stsd?: {
            entries?: Array<Record<string, unknown>>;
          };
        };
      };
    };
  };
};

export type DemuxedClip = {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  /** avcC/hvcC codec-specific bytes for VideoDecoderConfig.description. */
  description: Uint8Array | null;
  durationSec: number;
  samples: DemuxedSampleMeta[];
  /** EncodedVideoChunk init for sample `i`. */
  chunkAt: (i: number) => EncodedVideoChunkInit;
  decoderConfig: () => VideoDecoderConfig;
};

function extractDescription(file: Mp4BoxFile, trackId: number): Uint8Array | null {
  try {
    const track = file.getTrackById(trackId);
    const entries = track?.mdia?.minf?.stbl?.stsd?.entries ?? [];
    for (const entry of entries) {
      const box = (entry.avcC ?? entry.hvcC ?? entry.vpcC ?? entry.av1C) as
        | { write: (stream: unknown) => void }
        | undefined;
      if (!box) continue;
      const stream = new MP4Box.DataStream(
        undefined,
        0,
        MP4Box.Endianness.BIG_ENDIAN
      ) as unknown as { buffer: ArrayBuffer; position: number };
      box.write(stream);
      // Skip the 8-byte box header (size + fourcc).
      return new Uint8Array(stream.buffer, 8, stream.position - 8);
    }
  } catch {
    /* fall through */
  }
  return null;
}

/** Demux the full MP4 at `url` and index its first video track. */
export async function demuxMp4Clip(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<DemuxedClip> {
  const res = await fetchImpl(url, { mode: "cors" });
  if (!res.ok) throw new Error(`Proxy fetch failed (${res.status}): ${url}`);
  const buffer = (await res.arrayBuffer()) as ArrayBuffer & { fileStart?: number };

  const file = MP4Box.createFile() as unknown as Mp4BoxFile;

  let info: Mp4BoxInfo | null = null;
  let error: string | null = null;
  const rawSamples: Mp4BoxSample[] = [];

  file.onError = (_module, message) => {
    error = message;
  };
  file.onReady = (i) => {
    info = i;
    const track = i.videoTracks[0];
    if (track) {
      file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
      file.start();
    }
  };
  file.onSamples = (_trackId, _user, samples) => {
    rawSamples.push(...samples);
  };

  buffer.fileStart = 0;
  file.appendBuffer(buffer);
  file.flush();

  if (error) throw new Error(`MP4 demux failed: ${error}`);
  const track = (info as Mp4BoxInfo | null)?.videoTracks?.[0];
  if (!track) throw new Error(`No video track in ${url}`);

  const timescale = track.timescale || 1;
  const metas: DemuxedSampleMeta[] = rawSamples.map((s, i) => ({
    index: i,
    isSync: Boolean(s.is_sync),
    ctsSec: s.cts / (s.timescale || timescale),
    durationSec: s.duration / (s.timescale || timescale),
  }));

  const description = extractDescription(file, track.id);
  const codedWidth = track.video?.width || track.track_width;
  const codedHeight = track.video?.height || track.track_height;
  const codec = track.codec;
  const durationSec = track.duration / timescale;

  return {
    codec,
    codedWidth,
    codedHeight,
    description,
    durationSec,
    samples: metas,
    chunkAt: (i: number) => {
      const s = rawSamples[i];
      if (!s) throw new Error(`Sample ${i} out of range (${rawSamples.length})`);
      const scale = s.timescale || timescale;
      return {
        type: s.is_sync ? "key" : "delta",
        timestamp: Math.round((s.cts / scale) * 1_000_000),
        duration: Math.round((s.duration / scale) * 1_000_000),
        data: s.data,
      };
    },
    decoderConfig: () => {
      const config: VideoDecoderConfig = {
        codec,
        codedWidth,
        codedHeight,
      };
      if (description) config.description = description;
      return config;
    },
  };
}
