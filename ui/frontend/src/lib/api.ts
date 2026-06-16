/**
 * API origin for `fetch()`.
 *
 * Defaults to same-origin `/api` so dev works with a single SSH-tunneled Next port
 * (Next rewrites `/api/*` to the FastAPI host; see `next.config.mjs`). Long jobs
 * (FLF / I2V) are covered by `experimental.proxyTimeout` in `next.config.mjs`.
 *
 * Override with `NEXT_PUBLIC_API_BASE_URL` when the browser should hit FastAPI
 * directly (e.g. `http://127.0.0.1:8000` on the same host as the API).
 */
function resolveApiBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (explicit) return explicit;
  return "/api";
}

export const API_BASE_URL = resolveApiBaseUrl();

export type NormalizedAppError = {
  title: string;
  message: string;
  details?: string;
};

export function normalizeAppError(
  error: unknown,
  fallbackMessage = "Request failed",
  fallbackTitle = "Error"
): NormalizedAppError {
  if (error instanceof Error) {
    return {
      title: fallbackTitle,
      message: error.message || fallbackMessage,
      details: error.stack,
    };
  }
  if (typeof error === "string") {
    return { title: fallbackTitle, message: error || fallbackMessage };
  }
  try {
    return {
      title: fallbackTitle,
      message: fallbackMessage,
      details: JSON.stringify(error),
    };
  } catch {
    return {
      title: fallbackTitle,
      message: fallbackMessage,
      details: String(error),
    };
  }
}

/** Plain-text body Next dev returns when the /api rewrite proxy fails (often timeout @ 30s). */
function isNextProxyPlainInternalError(status: number, snippet: string): boolean {
  return status === 500 && /^internal server error$/i.test(snippet.trim());
}

function formatFailedResponseError(status: number, snippet: string): string {
  const base = `API error ${status}${snippet ? `: ${snippet}` : ""}`.trim();
  if (isNextProxyPlainInternalError(status, snippet)) {
    return (
      `${base}\n` +
      "This response is usually from the Next.js dev proxy (not FastAPI): the upstream request hit the default ~30s limit or the connection failed. " +
      "If you are on next dev, restart after raising experimental.proxyTimeout in next.config.mjs, or set NEXT_PUBLIC_API_BASE_URL to a reachable API origin to skip the proxy. " +
      "Check the terminal running `next dev` for “Failed to proxy”."
    );
  }
  return base;
}

function encodeRelPathForEndpoint(relPath: string): string {
  // relPath can contain slashes (e.g. "char/base.png").
  // Encode each path segment so slashes remain intact for the path-param endpoint.
  return relPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/** Format FastAPI `HTTPException` / JSON `detail` for display (readJson, NDJSON streams, etc.). */
export function formatFastApiDetailMessage(status: number, detail: unknown): string | null {
  if (typeof detail === "string" && detail.trim()) {
    return formatFailedResponseError(status, detail.trim());
  }
  if (Array.isArray(detail)) {
    const lines = detail
      .map((item: { msg?: string; loc?: unknown }) => {
        const loc = Array.isArray(item?.loc) ? item.loc.join(".") : "";
        const m = typeof item?.msg === "string" ? item.msg : JSON.stringify(item);
        return loc ? `${loc}: ${m}` : m;
      })
      .filter(Boolean);
    const joined = lines.length ? lines.join("\n") : JSON.stringify(detail);
    return `API error ${status}: ${joined}`.trim();
  }
  if (detail && typeof detail === "object") {
    const msgParts: string[] = [];
    const stage =
      typeof (detail as { stage?: unknown }).stage === "string"
        ? String((detail as { stage: string }).stage).trim()
        : "";
    const errMsg =
      typeof (detail as { error?: unknown }).error === "string"
        ? (detail as { error: string }).error
        : typeof (detail as { message?: unknown }).message === "string"
          ? (detail as { message: string }).message
          : "";
    const head = `API error ${status}${stage ? ` [${stage}]` : ""}${
      errMsg ? `: ${errMsg}` : ""
    }`.trim();
    msgParts.push(head);

    if (
      typeof (detail as { startIndex?: unknown }).startIndex === "number" &&
      typeof (detail as { endIndex?: unknown }).endIndex === "number"
    ) {
      msgParts.push(
        `Timeline indices: ${(detail as { startIndex: number }).startIndex} → ${(detail as { endIndex: number }).endIndex}`
      );
    }

    if (typeof (detail as { prompt_id?: unknown }).prompt_id === "string" && (detail as { prompt_id: string }).prompt_id) {
      msgParts.push(`prompt_id: ${(detail as { prompt_id: string }).prompt_id}`);
    }
    if (
      (detail as { prompt_index?: unknown }).prompt_index !== undefined &&
      (detail as { prompt_index?: unknown }).prompt_index !== null
    ) {
      msgParts.push(`prompt_index: ${String((detail as { prompt_index: unknown }).prompt_index)}`);
    }

    const comfy = (detail as { comfy?: unknown }).comfy;
    if (comfy && typeof comfy === "object") {
      const c = comfy as {
        status_str?: string;
        outputs_keys?: string[];
        message_types?: string[];
        messages_tail?: unknown[];
        execution_errors?: unknown[];
        outputs_summary?: unknown;
      };
      const statusStr = typeof c.status_str === "string" ? c.status_str : "";
      const outputsKeys = Array.isArray(c.outputs_keys) ? c.outputs_keys.join(", ") : "";
      const comfyHead = `Comfy: ${statusStr || "unknown"} outputs=[${outputsKeys}]`.trim();
      if (comfyHead) msgParts.push(comfyHead);

      if (Array.isArray(c.message_types) && c.message_types.length > 0) {
        msgParts.push("Comfy events: " + c.message_types.join(" → "));
      } else {
        const msgs = Array.isArray(c.messages_tail) ? c.messages_tail : [];
        if (msgs.length) {
          const lines = msgs
            .slice(-12)
            .map((m: unknown) => {
              if (Array.isArray(m) && m.length >= 1) return String(m[0]);
              return JSON.stringify(m);
            })
            .filter((s: string) => s && s !== "null" && s !== "undefined");
          if (lines.length) {
            msgParts.push("Comfy messages: " + lines.join(" → "));
          }
        }
      }

      const execErrs = Array.isArray(c.execution_errors) ? c.execution_errors : [];
      for (const ee of execErrs) {
        if (!ee || typeof ee !== "object") continue;
        const ex = ee as Record<string, unknown>;
        const parts: string[] = [];
        if (ex.node_id !== undefined) parts.push(`node_id=${String(ex.node_id)}`);
        if (typeof ex.node_type === "string" && ex.node_type) parts.push(`node_type=${ex.node_type}`);
        if (typeof ex.exception_type === "string" && ex.exception_type)
          parts.push(`type=${ex.exception_type}`);
        if (typeof ex.exception_message === "string" && ex.exception_message)
          parts.push(`message=${ex.exception_message}`);
        if (parts.length) msgParts.push("Comfy execution_error: " + parts.join(" "));
        if (typeof ex.traceback_tail === "string" && ex.traceback_tail.trim()) {
          msgParts.push(ex.traceback_tail.trim());
        }
      }

      const summ = c.outputs_summary;
      const keysArr = Array.isArray(c.outputs_keys) ? c.outputs_keys : [];
      let needOutSummary = keysArr.length === 0;
      if (!needOutSummary && summ && typeof summ === "object") {
        needOutSummary = Object.values(summ as Record<string, { image_count?: number }>).every(
          (v) =>
            !v ||
            typeof v !== "object" ||
            typeof v.image_count !== "number" ||
            v.image_count === 0
        );
      }
      if (needOutSummary && summ && typeof summ === "object" && Object.keys(summ as object).length > 0) {
        try {
          const s = JSON.stringify(summ);
          msgParts.push("Comfy outputs_summary: " + s.slice(0, 2000));
        } catch {
          /* ignore */
        }
      }
    }

    if (
      typeof (detail as { comfy_fetch_error?: unknown }).comfy_fetch_error === "string" &&
      (detail as { comfy_fetch_error: string }).comfy_fetch_error
    ) {
      msgParts.push(`comfy_fetch_error: ${(detail as { comfy_fetch_error: string }).comfy_fetch_error}`);
    }

    return msgParts.join("\n");
  }
  return null;
}

/**
 * Prepend ``charKey`` to ``relPath`` when the value is character-relative (no
 * leading ``<charKey>/`` segment). This lets callers pass either storage-relative
 * paths (``<charKey>/poses/foo.png``) or character-relative paths (``poses/foo.png``);
 * both produce the same URL. Without ``charKey`` the input is returned unchanged.
 */
export function prefixCharKeyIfCharRelative(
  relPath: string,
  charKey?: string,
): string {
  if (!charKey) return relPath;
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return normalized;
  const prefix = `${charKey}/`;
  if (normalized.startsWith(prefix)) return normalized;
  return prefix + normalized;
}

export function assetUrlFromRelPath(relPath: string, charKey?: string): string {
  const resolved = prefixCharKeyIfCharRelative(relPath, charKey);
  return `${API_BASE_URL}/assets/storage/${encodeRelPathForEndpoint(resolved)}`;
}

export function assetDownloadUrlFromRelPath(
  relPath: string,
  charKey?: string,
): string {
  const resolved = prefixCharKeyIfCharRelative(relPath, charKey);
  return `${API_BASE_URL}/assets/storage_download/${encodeRelPathForEndpoint(resolved)}`;
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    // Clone so we can always recover raw text (Next/proxy HTML, truncated JSON, etc.).
    const rawText = await res.clone().text().catch(() => "");
    const trimmed = rawText.trim();
    const snippet =
      trimmed.length > 2400 ? `${trimmed.slice(0, 2400)}…` : trimmed;

    let body: any = null;
    if (trimmed) {
      try {
        body = JSON.parse(trimmed);
      } catch {
        body = null;
      }
    }

    const detail = body?.detail;
    const formatted = formatFastApiDetailMessage(res.status, detail);
    if (formatted) throw new Error(formatted);

    throw new Error(formatFailedResponseError(res.status, snippet));
  }
  return (await res.json()) as T;
}

export type HubCharacter = {
  charKey: string;
  coverRelPath: string;
};

export type HubLocation = {
  locationKey: string;
  coverRelPath: string;
};

export type CoverCandidate = {
  relPath: string;
  caption: string;
};

export async function apiHubCharacters(): Promise<HubCharacter[]> {
  const res = await fetch(`${API_BASE_URL}/hub/characters`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<HubCharacter[]>(res);
}

export async function apiLocationHubItems(): Promise<HubLocation[]> {
  const res = await fetch(`${API_BASE_URL}/location/hub/items`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<HubLocation[]>(res);
}

export async function apiLocationHubRename(
  locationKey: string,
  newName: string
): Promise<{ newLocationKey: string }> {
  const res = await fetch(
    `${API_BASE_URL}/location/hub/${encodeURIComponent(locationKey)}/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newName }),
      credentials: "omit",
    }
  );
  return readJson<{ newLocationKey: string }>(res);
}

export async function apiLocationHubDelete(locationKey: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/location/hub/${encodeURIComponent(locationKey)}/delete`,
    { method: "POST", credentials: "omit" }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiLocationHubCoverCandidates(
  locationKey: string
): Promise<CoverCandidate[]> {
  const res = await fetch(
    `${API_BASE_URL}/location/hub/${encodeURIComponent(locationKey)}/cover_candidates`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<CoverCandidate[]>(res);
}

export async function apiLocationHubChangeCover(
  locationKey: string,
  relPath: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/location/hub/${encodeURIComponent(locationKey)}/change_cover`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relPath }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

// --- Shot hub ---

export type HubShot = {
  shotKey: string;
  coverRelPath: string;
};

export async function apiShotHubItems(): Promise<HubShot[]> {
  const res = await fetch(`${API_BASE_URL}/shot/hub/items`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<HubShot[]>(res);
}

export async function apiShotHubRename(
  shotKey: string,
  newName: string
): Promise<{ newShotKey: string }> {
  const res = await fetch(
    `${API_BASE_URL}/shot/hub/${encodeURIComponent(shotKey)}/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newName }),
      credentials: "omit",
    }
  );
  return readJson<{ newShotKey: string }>(res);
}

export async function apiShotHubDelete(shotKey: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/shot/hub/${encodeURIComponent(shotKey)}/delete`,
    { method: "POST", credentials: "omit" }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiShotHubSetGenerated(
  shotKey: string,
  relPath: string
): Promise<{ coverRelPath: string }> {
  const res = await fetch(
    `${API_BASE_URL}/shot/hub/${encodeURIComponent(shotKey)}/set_generated`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relPath }),
      credentials: "omit",
    }
  );
  return readJson<{ coverRelPath: string }>(res);
}

// ----------------------------------------------------------------------------
// Video timeline (multi-track composite editor)
// ----------------------------------------------------------------------------

export type HubTimeline = {
  timelineKey: string;
  coverRelPath: string;
};

export type TimelineClipType = "video" | "image" | "audio" | "geometry" | "text";

export type GeometryTemplate = "rect" | "ellipse" | "line" | "polygon" | "custom";

export type SavedGeometryShape = {
  id: string;
  name: string;
  createdAt: number;
  geometry: TimelineGeometry;
};

export type GeometryPoint = {
  x: number;
  y: number;
  handleIn?: { x: number; y: number };
  handleOut?: { x: number; y: number };
};

export type TimelineGeometry = {
  template: GeometryTemplate;
  closed: boolean;
  points: GeometryPoint[];
  fill?: string;
  stroke?: { color: string; width: number };
  cornerRadius?: number;
};

export type TimelineText = {
  content: string;
  fontFamilyId: string;
  fontWeight: number;
  fontStyle: "normal";
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
};

export type TimelineTransitionType = "fade" | "dissolve" | "wipe" | "slide";

export type TransitionDirection = "left" | "right" | "up" | "down";

export type TimelineTransitionOut = {
  type: TimelineTransitionType;
  /** Crossfade length in seconds (0.1–2.0). */
  duration: number;
  /** Wipe/slide only; default left. Ignored for fade/dissolve. */
  direction?: TransitionDirection;
};

/** Procedural motion layered on top of trajectory waypoints (preview playback). */
export type TrajectoryMotionId =
  | "none"
  | "pulse"
  | "sway"
  | "flicker"
  | "drift"
  | "bounce"
  | "orbit"
  | "overshoot"
  | "bob"
  | "shake"
  | "wiggle"
  | "jitter";

export type TimelineClip = {
  id: string;
  type: TimelineClipType;
  /** Storage-relative path under ``timelines/<key>/clips/`` served by /assets/storage/. */
  srcRelPath: string;
  /** Seconds along the timeline where the clip begins. */
  start: number;
  /** Trim start within the source (seconds). */
  inPoint: number;
  /** Trim end within the source (seconds). */
  outPoint: number;
  /** Playback speed multiplier (1 = normal). */
  speed: number;
  /** Timeline duration in seconds = (outPoint - inPoint) / speed. */
  duration: number;
  /** Source media duration in seconds (video/audio); caps right-trim. */
  srcDuration?: number;
  naturalW?: number;
  naturalH?: number;
  /** In-frame transform for the preview: fractional offset + scale multiplier. */
  transform?: { x: number; y: number; scale: number };
  /** Motion path: clip moves through these waypoints over its duration. */
  trajectory?: {
    /** Procedural oscillation on top of the path (preview + MP4 export). */
    motion?: TrajectoryMotionId;
    /** Intensity 0–100 for motion amplitude. */
    motionAmount?: number;
    waypoints: Array<{
      t: number;       // 0–1 fraction of clip duration
      x: number;       // same space as transform.x (fractional from center)
      y: number;
      scale: number;   // same as transform.scale
      cpx?: number;    // bezier control point for the outgoing segment
      cpy?: number;
    }>;
  };
  /** Clip volume envelope (audio clips): 0–100 level, 50 = unity gain. */
  volumeAutomation?: {
    points: Array<{
      t: number;
      level: number;
      cpt?: number;
      cpl?: number;
    }>;
  };
  /** Where this clip was imported from (for provenance / re-import). */
  source?: {
    charKey?: string;
    sequenceName?: string;
    galleryItemId?: string;
    shotKey?: string;
    locationKey?: string;
    combined?: boolean;
  };
  /** Vector shape clip (no srcRelPath required). */
  geometry?: TimelineGeometry;
  /** Text overlay clip (no srcRelPath required). */
  text?: TimelineText;
  /** Outgoing crossfade to the next connected clip on the same track. */
  transitionOut?: TimelineTransitionOut;
};

export type TimelineTrack = {
  id: string;
  name: string;
  kind: "video" | "audio" | "neutral";
  clips: TimelineClip[];
  /** When true, the track is excluded from preview playback. */
  hidden?: boolean;
};

export type TimelineManifest = {
  version: number;
  fps: number;
  previewAspect: "16:9" | "4:3" | "1:1" | "9:16";
  tracks: TimelineTrack[];
};

export async function apiTimelineHubItems(): Promise<HubTimeline[]> {
  const res = await fetch(`${API_BASE_URL}/timeline/hub/items`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<HubTimeline[]>(res);
}

export async function apiTimelineCreate(name?: string): Promise<{ timelineKey: string }> {
  const res = await fetch(`${API_BASE_URL}/timeline/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: name ?? "Timeline" }),
    credentials: "omit",
  });
  return readJson<{ timelineKey: string }>(res);
}

export async function apiTimelineHubRename(
  timelineKey: string,
  newName: string
): Promise<{ newTimelineKey: string }> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/hub/${encodeURIComponent(timelineKey)}/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newName }),
      credentials: "omit",
    }
  );
  return readJson<{ newTimelineKey: string }>(res);
}

export async function apiTimelineHubDelete(timelineKey: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/hub/${encodeURIComponent(timelineKey)}/delete`,
    { method: "POST", credentials: "omit" }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiTimelineGet(timelineKey: string): Promise<TimelineManifest> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/${encodeURIComponent(timelineKey)}/manifest`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<TimelineManifest>(res);
}

export async function apiTimelinePut(
  timelineKey: string,
  manifest: TimelineManifest
): Promise<{ ok: boolean }> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/${encodeURIComponent(timelineKey)}/manifest`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(manifest),
      credentials: "omit",
    }
  );
  return readJson<{ ok: boolean }>(res);
}

/** Copy a location/shot/character image into the timeline as an image clip. */
export async function apiTimelineImportImage(params: {
  timelineKey: string;
  sourceRelPath: string;
}): Promise<{ type: "image"; srcRelPath: string; width: number; height: number }> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/${encodeURIComponent(params.timelineKey)}/import_image`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRelPath: params.sourceRelPath }),
      credentials: "omit",
    }
  );
  return readJson<{ type: "image"; srcRelPath: string; width: number; height: number }>(res);
}

export type TimelineAudioClipResult = {
  type: "audio";
  srcRelPath: string;
  durationSec: number;
};

export async function apiTimelineImportAudio(params: {
  timelineKey: string;
  sourceRelPath: string;
}): Promise<TimelineAudioClipResult> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/${encodeURIComponent(params.timelineKey)}/import_audio`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRelPath: params.sourceRelPath }),
      credentials: "omit",
    }
  );
  return readJson<TimelineAudioClipResult>(res);
}

export type TimelineAsset = {
  id: string;
  relPath: string;
  kind: "t2i";
  prompt?: string;
  modelMode?: "anime" | "general";
  width: number;
  height: number;
  createdAt?: number;
};

export type TimelineAssetLayout = {
  order: string[];
  items: TimelineAsset[];
};

export async function apiTimelineAssetsLayout(
  timelineKey: string
): Promise<TimelineAssetLayout> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/${encodeURIComponent(timelineKey)}/assets`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<TimelineAssetLayout>(res);
}

export async function apiTimelineAssetDelete(
  timelineKey: string,
  assetId: string
): Promise<{ ok: boolean }> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/${encodeURIComponent(timelineKey)}/assets/${encodeURIComponent(assetId)}`,
    { method: "DELETE", credentials: "omit" }
  );
  return readJson<{ ok: boolean }>(res);
}

export type SavedShapesLayout = {
  items: SavedGeometryShape[];
};

export async function apiTimelineSavedShapes(
  timelineKey: string
): Promise<SavedShapesLayout> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/${encodeURIComponent(timelineKey)}/shapes`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<SavedShapesLayout>(res);
}

export async function apiSaveTimelineShape(
  timelineKey: string,
  body: { name: string; geometry: TimelineGeometry }
): Promise<{ item: SavedGeometryShape }> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/${encodeURIComponent(timelineKey)}/shapes`,
    {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  return readJson<{ item: SavedGeometryShape }>(res);
}

export async function apiDeleteTimelineShape(
  timelineKey: string,
  shapeId: string
): Promise<{ ok: boolean }> {
  const res = await fetch(
    `${API_BASE_URL}/timeline/${encodeURIComponent(timelineKey)}/shapes/${encodeURIComponent(shapeId)}`,
    { method: "DELETE", credentials: "omit" }
  );
  return readJson<{ ok: boolean }>(res);
}

/** Materialize a character sequence (or one gallery video item) into an mp4 clip. */
export function runTimelineImportSequenceWsJob(params: {
  timelineKey: string;
  charKey: string;
  sequenceName: string;
  galleryItemId?: string;
  onLogLine: (line: string) => void;
}): Promise<
  WsDoneMessage<{
    type: "video";
    srcRelPath: string;
    durationSec: number;
    width: number;
    height: number;
  }>
> {
  const { timelineKey, onLogLine, ...payload } = params;
  const url = wsUrlForPath(`/timeline/${encodeURIComponent(timelineKey)}/import_sequence/ws`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: {
          type: "video";
          srcRelPath: string;
          durationSec: number;
          width: number;
          height: number;
        };
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        onLogLine(data.line);
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(
          data as WsDoneMessage<{
            type: "video";
            srcRelPath: string;
            durationSec: number;
            width: number;
            height: number;
          }>
        );
      }
    };
  });
}

type TimelineVideoClipResult = {
  type?: "video";
  srcRelPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps?: number;
};
type TimelineImageClipResult = {
  type: "image";
  srcRelPath: string;
  width: number;
  height: number;
};

export type Sam3Point = { x: number; y: number };

export type Sam3SegmentOptions = {
  threshold?: number;
  refineIterations?: number;
  detectionThreshold?: number;
  maskGrowPx?: number;
  maskBlurPx?: number;
};

export type RvmBgOptions = {
  preset?: "fast" | "quality";
  downsampleRatio?: number;
  backbone?: "mobilenetv3" | "resnet50";
  alphaDilatePx?: number;
  useSourceRgb?: boolean;
};

export type RmbgBgOptions = {
  mask_offset?: number;
  refine_foreground?: boolean;
  mask_blur?: number;
  sensitivity?: number;
  process_res?: number;
};

type TimelineSegmentClipResult = {
  type: "image" | "video";
  srcRelPath: string;
  width: number;
  height: number;
  durationSec?: number;
};

type TimelineSegmentPreviewResult = {
  maskPngBase64: string;
};

/** Shared WS runner for timeline generation jobs (FLF / I2V / AI-edit). */
function runTimelineGenWsJob<T>(
  path: string,
  payload: Record<string, unknown>,
  onLogLine: (line: string) => void
): Promise<WsDoneMessage<T>> {
  const url = wsUrlForPath(path);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onmessage = (ev) => {
      let data: { type?: string; line?: string };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") onLogLine(data.line);
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<T>);
      }
    };
  });
}

/** FLF (first-last-frame) between two timeline image clips → new video clip. */
export function runTimelineFlfWsJob(params: {
  timelineKey: string;
  imageRelPathA: string;
  imageRelPathB: string;
  length?: number;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<TimelineVideoClipResult>> {
  const { timelineKey, onLogLine, ...payload } = params;
  return runTimelineGenWsJob<TimelineVideoClipResult>(
    `/timeline/${encodeURIComponent(timelineKey)}/flf/ws`,
    payload,
    onLogLine
  );
}

/** I2V (image-to-video) from one timeline image clip + prompt → new video clip. */
export function runTimelineI2vWsJob(params: {
  timelineKey: string;
  imageRelPath: string;
  prompt: string;
  length?: number;
  width?: number;
  height?: number;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<TimelineVideoClipResult>> {
  const { timelineKey, onLogLine, ...payload } = params;
  return runTimelineGenWsJob<TimelineVideoClipResult>(
    `/timeline/${encodeURIComponent(timelineKey)}/i2v/ws`,
    payload,
    onLogLine
  );
}

/** AI-edit a timeline image clip (prompt + optional mask) → new image clip. */
export function runTimelineAiEditWsJob(params: {
  timelineKey: string;
  imageRelPath: string;
  prompt: string;
  maskPngBase64?: string;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<TimelineImageClipResult>> {
  const { timelineKey, onLogLine, ...payload } = params;
  return runTimelineGenWsJob<TimelineImageClipResult>(
    `/timeline/${encodeURIComponent(timelineKey)}/ai_edit/ws`,
    payload,
    onLogLine
  );
}

type TimelineT2iResult = { item: TimelineAsset };

/** T2I → timeline asset gallery entry. */
export function runTimelineT2iWsJob(params: {
  timelineKey: string;
  promptText: string;
  modelMode: "anime" | "general";
  previewAspect?: TimelineManifest["previewAspect"];
  width?: number;
  height?: number;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<TimelineT2iResult>> {
  const { timelineKey, onLogLine, ...payload } = params;
  return runTimelineGenWsJob<TimelineT2iResult>(
    `/timeline/${encodeURIComponent(timelineKey)}/t2i/ws`,
    payload,
    onLogLine
  );
}

/** SAM3 mask preview for timeline segment UI (image or video frame). */
export function runTimelineSegmentPreviewWsJob(params: {
  timelineKey: string;
  clipRelPath: string;
  clipType: "image" | "video";
  positiveCoords: Sam3Point[];
  negativeCoords?: Sam3Point[];
  textPrompt?: string;
  inPointSec?: number;
  localTimeSec?: number;
  speed?: number;
  sam3Options?: Sam3SegmentOptions;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<TimelineSegmentPreviewResult>> {
  const { timelineKey, onLogLine, ...payload } = params;
  return runTimelineGenWsJob<TimelineSegmentPreviewResult>(
    `/timeline/${encodeURIComponent(timelineKey)}/segment_preview/ws`,
    payload,
    onLogLine
  );
}

/** SAM3 segment → new transparent clip in timeline storage. */
export function runTimelineSegmentWsJob(params: {
  timelineKey: string;
  clipRelPath: string;
  clipType: "image" | "video";
  positiveCoords: Sam3Point[];
  negativeCoords?: Sam3Point[];
  textPrompt?: string;
  inPointSec?: number;
  localTimeSec?: number;
  speed?: number;
  sam3Options?: Sam3SegmentOptions;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<TimelineSegmentClipResult>> {
  const { timelineKey, onLogLine, ...payload } = params;
  return runTimelineGenWsJob<TimelineSegmentClipResult>(
    `/timeline/${encodeURIComponent(timelineKey)}/segment/ws`,
    payload,
    onLogLine
  );
}

/** Remove background from a video clip via RobustVideoMatting → WebM + alpha. */
export function runTimelineVideoRemoveBgWsJob(params: {
  timelineKey: string;
  videoRelPath: string;
  preset?: "fast" | "quality";
  downsampleRatio?: number;
  backbone?: "mobilenetv3" | "resnet50";
  alphaDilatePx?: number;
  useSourceRgb?: boolean;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<TimelineVideoClipResult>> {
  const { timelineKey, onLogLine, ...payload } = params;
  return runTimelineGenWsJob<TimelineVideoClipResult>(
    `/timeline/${encodeURIComponent(timelineKey)}/remove_video_bg/ws`,
    payload,
    onLogLine
  );
}

/** Remove background from a video clip via per-frame RMBG-2.0 → WebM + alpha. */
export function runTimelineVideoRemoveBgRmbgWsJob(params: {
  timelineKey: string;
  videoRelPath: string;
  outputFps24?: boolean;
  recycleMask?: boolean;
  rmbg?: RmbgBgOptions;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<TimelineVideoClipResult>> {
  const { timelineKey, onLogLine, ...payload } = params;
  return runTimelineGenWsJob<TimelineVideoClipResult>(
    `/timeline/${encodeURIComponent(timelineKey)}/remove_video_bg_rmbg/ws`,
    payload,
    onLogLine
  );
}

/** Export the full timeline as a single concatenated MP4. */
export function runTimelineExportMp4WsJob(params: {
  timelineKey: string;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<{ relPath: string }>> {
  const { timelineKey, onLogLine } = params;
  return runTimelineGenWsJob<{ relPath: string }>(
    `/timeline/${encodeURIComponent(timelineKey)}/export_mp4/ws`,
    {},
    onLogLine
  );
}

// ----------------------------------------------------------------------------
// Motion reference generation (KiMoD)
// ----------------------------------------------------------------------------

export type MotionRefSegment = {
  text: string;
  duration: number; // seconds
};

/** Returned by the generate WS job once generation completes. */
export type MotionRefManifest = {
  motionKey: string;
  fps: number;
  frameCount: number;
  jointCount: number;
  /** Whether a skinned SMPL-X mesh was produced (mesh.f16.gz + mesh_faces.json.gz). */
  hasMesh?: boolean;
  vertexCount?: number;
  faceCount?: number;
  /** Bone parent/child index pairs for skeleton preview when mesh is unavailable. */
  bones?: number[][];
  displayMode?: "mesh" | "skeleton";
  /** Storage-relative path to joints.json.gz (served by /assets/storage/). */
  jointsRelPath?: string;
  segments: MotionRefSegment[];
};

/** A saved motion-ref shot bookmark (viewer capture at frame + camera). */
export type MotionRefShot = {
  id: string;
  motionKey: string;
  frameIndex: number;
  azimuth: number;
  elevation: number;
  relPath: string;
  keypointId?: string | null;
  cropBox?: { x: number; y: number; width: number; height: number };
  imageWidth?: number;
  imageHeight?: number;
  createdAt?: number;
};

export type MotionShotsLayout = {
  folders: KeypointFolder[];
  rootOrder: string[];
  folderOrder: Record<string, string[]>;
  items: MotionRefShot[];
};

export type MotionRefListItem = {
  motionKey: string;
  fps: number;
  frameCount: number;
  jointCount: number;
  hasMesh?: boolean;
  vertexCount?: number;
  faceCount?: number;
  bones?: number[][];
  displayMode?: "mesh" | "skeleton";
  thumbnailRelPath: string;
  segments: MotionRefSegment[];
};

/** Kill + relaunch ComfyUI on port 8188, streaming the restart logs. */
export function runRestartComfyWsJob(params: {
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<{ port: number }>> {
  const { onLogLine } = params;
  const url = wsUrlForPath("/settings/comfy/restart/ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "start" }));
    ws.onmessage = (ev) => {
      let data: { type?: string; line?: string };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") onLogLine(data.line);
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<{ port: number }>);
      }
    };
  });
}

/** Stream a motion-generation job. Logs are emitted during long inference. */
export function runMotionRefGenerateWsJob(params: {
  motionName?: string;
  segments: MotionRefSegment[];
  numSamples?: number;
  diffusionSteps?: number;
  model?: string;
  /** Optional 77×3 joint positions to constrain the first frame of generation. */
  startingPose?: number[][];
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<MotionRefManifest>> {
  const { onLogLine, ...payload } = params;
  const url = wsUrlForPath("/motion_ref/generate/ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => ws.send(JSON.stringify(payload));
    ws.onmessage = (ev) => {
      let data: { type?: string; line?: string };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") onLogLine(data.line);
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<MotionRefManifest>);
      }
    };
  });
}

/** Stream a reskin job for an existing skeleton-only motion. */
export function runMotionRefSkinWsJob(
  motionKey: string,
  onLogLine: (line: string) => void,
): Promise<WsDoneMessage<{ motionKey: string; hasMesh: boolean; vertexCount: number; faceCount: number }>> {
  const url = wsUrlForPath(`/motion_ref/${encodeURIComponent(motionKey)}/skin/ws`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => ws.send("{}");
    ws.onmessage = (ev) => {
      let data: { type?: string; line?: string };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") onLogLine(data.line);
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<{ motionKey: string; hasMesh: boolean; vertexCount: number; faceCount: number }>);
      }
    };
  });
}

/** Fetch the gzipped joints JSON array for a motion (ArrayBuffer). */
export async function apiMotionRefJoints(motionKey: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `${API_BASE_URL}/motion_ref/${encodeURIComponent(motionKey)}/joints`,
    { method: "GET", credentials: "omit" }
  );
  if (!res.ok) throw new Error(`Failed to fetch joints: ${res.status}`);
  return res.arrayBuffer();
}

/** Gzipped float16 [T,V,3] SMPL-X vertex stream (decompress + decode client-side). */
export async function apiMotionRefMesh(motionKey: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `${API_BASE_URL}/motion_ref/${encodeURIComponent(motionKey)}/mesh`,
    { method: "GET", credentials: "omit" }
  );
  if (!res.ok) throw new Error(`Failed to fetch mesh: ${res.status}`);
  return res.arrayBuffer();
}

/** Gzipped JSON face index array [F][3] for the SMPL-X mesh (static across frames). */
export async function apiMotionRefMeshFaces(motionKey: string): Promise<ArrayBuffer> {
  const res = await fetch(
    `${API_BASE_URL}/motion_ref/${encodeURIComponent(motionKey)}/mesh_faces`,
    { method: "GET", credentials: "omit" }
  );
  if (!res.ok) throw new Error(`Failed to fetch mesh faces: ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Persist a client-side canvas screenshot (base64 PNG) as the motion's
 * gallery thumbnail. Pure file write on the backend — no KiMoD worker.
 */
export async function apiMotionRefSaveShotImage(params: {
  motionKey: string;
  pngBase64: string;
  shotName?: string;
}): Promise<{ shotRelPath: string }> {
  const { motionKey, ...body } = params;
  const res = await fetch(
    `${API_BASE_URL}/motion_ref/${encodeURIComponent(motionKey)}/save_shot_image`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    }
  );
  return readJson<{ shotRelPath: string }>(res);
}

export async function apiMotionRefList(): Promise<MotionRefListItem[]> {
  const res = await fetch(`${API_BASE_URL}/motion_ref/list`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<MotionRefListItem[]>(res);
}

export async function apiMotionRefDelete(motionKey: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/motion_ref/${encodeURIComponent(motionKey)}/delete`,
    { method: "POST", credentials: "omit" }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiMotionRefShotsLayout(): Promise<MotionShotsLayout> {
  const res = await fetch(`${API_BASE_URL}/motion_ref/shots/layout`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<MotionShotsLayout>(res);
}

export async function apiMotionRefShotSave(params: {
  motionKey: string;
  pngBase64: string;
  frameIndex: number;
  azimuth: number;
  elevation: number;
  cropBox?: { x: number; y: number; width: number; height: number };
  imageWidth?: number;
  imageHeight?: number;
}): Promise<MotionRefShot> {
  const res = await fetch(`${API_BASE_URL}/motion_ref/shots`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    credentials: "omit",
  });
  const data = await readJson<{ item: MotionRefShot }>(res);
  return data.item;
}

export async function apiMotionRefShotDelete(shotId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/motion_ref/shots/${encodeURIComponent(shotId)}`,
    { method: "DELETE", credentials: "omit" }
  );
  if (!res.ok) await readJson(res);
}

export async function apiMotionRefShotsReorderRoot(order: string[]): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/motion_ref/shots/reorder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "root", order }),
    credentials: "omit",
  });
  if (!res.ok) await readJson(res);
}

export async function apiMotionRefShotsReorderFolder(
  folderId: string,
  order: string[]
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/motion_ref/shots/reorder`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "folder", folderId, order }),
    credentials: "omit",
  });
  if (!res.ok) await readJson(res);
}

export async function apiMotionRefShotFolderCreate(
  name: string,
  itemIds: string[],
  parentFolderId?: string | null
): Promise<KeypointFolder> {
  const res = await fetch(`${API_BASE_URL}/motion_ref/shots/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      itemIds,
      parentFolderId: parentFolderId ?? null,
    }),
    credentials: "omit",
  });
  const data = await readJson<{ folder: KeypointFolder }>(res);
  return data.folder;
}

export async function apiMotionRefShotFolderRename(
  folderId: string,
  name: string
): Promise<KeypointFolder> {
  const res = await fetch(
    `${API_BASE_URL}/motion_ref/shots/folders/${encodeURIComponent(folderId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      credentials: "omit",
    }
  );
  const data = await readJson<{ folder: KeypointFolder }>(res);
  return data.folder;
}

export async function apiMotionRefShotFolderDelete(folderId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/motion_ref/shots/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE", credentials: "omit" }
  );
  if (!res.ok) await readJson(res);
}

export async function apiMotionRefShotFolderAssign(
  folderId: string | null,
  itemIds: string[]
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/motion_ref/shots/folders/assign`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folderId, itemIds }),
    credentials: "omit",
  });
  if (!res.ok) await readJson(res);
}

/** Run SDpose on a saved motion shot and add to pose ref (skips if already linked). */
export function runMotionRefShotAddToPoseWsJob(params: {
  shotId: string;
  onLogLine: (line: string) => void;
}): Promise<
  WsDoneMessage<{
    skipped?: boolean;
    item: PoseReference;
    shot?: MotionRefShot;
  }>
> {
  const { shotId, onLogLine } = params;
  const url = wsUrlForPath(
    `/motion_ref/shots/${encodeURIComponent(shotId)}/add_to_pose/ws`
  );
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "start" }));
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: {
          skipped?: boolean;
          item: PoseReference;
          shot?: MotionRefShot;
        };
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") onLogLine(data.line);
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(
          data as WsDoneMessage<{
            skipped?: boolean;
            item: PoseReference;
            shot?: MotionRefShot;
          }>
        );
      }
    };
  });
}

export type ShotLayerMeta = {
  charKey: string;
  imageRelPath: string;
  x: number;
  y: number;
  scale: number;
};

/**
 * Generate a shot via the Qwen image-edit service (backdrop = image 1,
 * composite = image 2). Streams log lines and resolves with the saved result.
 */
export function runShotCreateWsJob(params: {
  shotName: string;
  locationKey: string | null;
  locationImageRelPath: string;
  characters: ShotLayerMeta[];
  compositePngBase64: string;
  promptText: string;
  /** "i2i" = Qwen edit (default); "as_is" = save the overlay verbatim. */
  mode?: "i2i" | "as_is";
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<{ shotKey: string; outputRelPath: string }>> {
  const url = wsUrlForPath("/shot/create/ws");
  const { onLogLine, mode, ...rest } = params;
  const payload = { ...rest, mode: mode ?? "i2i" };
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: { shotKey: string; outputRelPath: string };
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        onLogLine(data.line);
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(
          data as WsDoneMessage<{ shotKey: string; outputRelPath: string }>
        );
      }
    };
  });
}

/**
 * Remove a character layer's background (RMBG-2.0). Streams log lines and
 * resolves with the rel path of a transparent PNG in the shots scratch dir.
 */
export function runShotRemoveBgWsJob(params: {
  imageRelPath: string;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<{ relPath: string }>> {
  const url = wsUrlForPath("/shot/remove_bg/ws");
  const { onLogLine, ...payload } = params;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: { relPath: string };
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        onLogLine(data.line);
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<{ relPath: string }>);
      }
    };
  });
}

/**
 * Generate a single new camera angle for an arbitrary image (shot composer layer /
 * generated scene, or a sequence frame). Returns the staged angled PNG's storage rel path.
 */
export function runShotMakeAngleWsJob(params: {
  imageRelPath: string;
  angleId: number;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<{ relPath: string }>> {
  const url = wsUrlForPath("/shot/make_angle/ws");
  const { onLogLine, ...payload } = params;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: { relPath: string };
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        onLogLine(data.line);
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<{ relPath: string }>);
      }
    };
  });
}

export async function apiHubCoverCandidates(
  charKey: string
): Promise<CoverCandidate[]> {
  const res = await fetch(
    `${API_BASE_URL}/hub/${encodeURIComponent(charKey)}/cover_candidates`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<CoverCandidate[]>(res);
}

export async function apiHubCover(charKey: string): Promise<{
  relPath: string;
  /** Detail gate preview: ``base_combined`` when present, else same as ``relPath`` (canonical base). */
  detailPreviewRelPath: string;
}> {
  const res = await fetch(
    `${API_BASE_URL}/hub/${encodeURIComponent(charKey)}/cover`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<{ relPath: string; detailPreviewRelPath: string }>(res);
}

export async function apiSettingsUpdateHfToken(hfToken: string): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/settings/hf_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hf_token: hfToken }),
    credentials: "omit",
  });
  await readJson<{ ok: boolean }>(res);
}

export async function apiSettingsGetHfToken(): Promise<string> {
  const res = await fetch(`${API_BASE_URL}/settings/hf_token`, {
    method: "GET",
    credentials: "omit",
  });
  const data = await readJson<{ hf_token: string }>(res);
  return typeof data.hf_token === "string" ? data.hf_token : "";
}

export async function apiHubDelete(charKey: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/hub/${encodeURIComponent(charKey)}/delete`,
    { method: "POST", credentials: "omit" }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiHubRename(
  charKey: string,
  newName: string
): Promise<{ newCharKey: string }> {
  const res = await fetch(
    `${API_BASE_URL}/hub/${encodeURIComponent(charKey)}/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newName }),
      credentials: "omit",
    }
  );
  return readJson<{ newCharKey: string }>(res);
}

export async function apiHubChangeCover(
  charKey: string,
  relPath: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/hub/${encodeURIComponent(charKey)}/change_cover`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ relPath }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

/** If hub cover file is missing, assign the first available character image as cover. */
export async function apiHubEnsureCover(charKey: string): Promise<{ reassigned: boolean }> {
  const res = await fetch(
    `${API_BASE_URL}/hub/${encodeURIComponent(charKey)}/ensure_cover`,
    { method: "POST", credentials: "omit" }
  );
  const data = await readJson<{ ok: boolean; reassigned?: boolean }>(res);
  return { reassigned: Boolean(data.reassigned) };
}

export type CloseupWizardState = {
  sessionId?: string;
  steps?: CloseupWizardStep[];
  currentStepIndex?: number;
  stepKey?: "front" | "left" | "right" | "back";
  stepLabel?: string;
  candidateRelPath?: string;
  compositePreviewRelPath?: string;
  saved?: Record<string, string>;
  failed?: Record<string, string>;
  error?: string | null;
  done?: boolean;
  next?: CloseupWizardState;
  closeupRelPath?: string;
  combinedRelPath?: string;
};

export async function apiHubCloseupWizardStart(
  charKey: string,
  onLogLine: (line: string) => void
): Promise<CloseupWizardState> {
  const done = await runHubWsJob<CloseupWizardState>({
    charKey,
    payload: { job: "start" },
    onLogLine,
  });
  if (!done.ok || !done.result) throw new Error(done.error ?? "Failed to start wizard");
  return done.result;
}

export async function apiHubCloseupWizardGenerateCurrent(
  charKey: string,
  sessionId: string,
  onLogLine: (line: string) => void
): Promise<CloseupWizardState> {
  const done = await runHubWsJob<CloseupWizardState>({
    charKey,
    payload: { job: "generate_current", sessionId },
    onLogLine,
  });
  if (!done.ok || !done.result) throw new Error(done.error ?? "Failed to generate angle");
  return done.result;
}

export async function apiHubCloseupWizardRegenerateCurrent(
  charKey: string,
  sessionId: string,
  onLogLine: (line: string) => void
): Promise<CloseupWizardState> {
  const done = await runHubWsJob<CloseupWizardState>({
    charKey,
    payload: { job: "regenerate_current", sessionId },
    onLogLine,
  });
  if (!done.ok || !done.result) throw new Error(done.error ?? "Failed to regenerate angle");
  return done.result;
}

export async function apiHubCloseupWizardSaveCurrentAndNext(
  charKey: string,
  sessionId: string,
  onLogLine: (line: string) => void
): Promise<CloseupWizardState> {
  const done = await runHubWsJob<CloseupWizardState>({
    charKey,
    payload: { job: "save_current_and_next", sessionId },
    onLogLine,
  });
  if (!done.ok || !done.result) throw new Error(done.error ?? "Failed to save angle");
  return done.result;
}

export async function apiHubCloseupWizardSaveCurrent(
  charKey: string,
  sessionId: string
): Promise<CloseupWizardState> {
  const done = await runHubWsJob<CloseupWizardState>({
    charKey,
    payload: { job: "save_current", sessionId },
    onLogLine: () => {},
  });
  if (!done.ok || !done.result) throw new Error(done.error ?? "Failed to save angle");
  return done.result;
}

export async function apiHubCloseupWizardGoLast(
  charKey: string,
  sessionId: string
): Promise<CloseupWizardState> {
  const done = await runHubWsJob<CloseupWizardState>({
    charKey,
    payload: { job: "go_last_angle", sessionId },
    onLogLine: () => {},
  });
  if (!done.ok || !done.result) throw new Error(done.error ?? "Failed to go last angle");
  return done.result;
}

export async function apiHubCloseupWizardGoNext(
  charKey: string,
  sessionId: string
): Promise<CloseupWizardState> {
  const done = await runHubWsJob<CloseupWizardState>({
    charKey,
    payload: { job: "go_next_angle", sessionId },
    onLogLine: () => {},
  });
  if (!done.ok || !done.result) throw new Error(done.error ?? "Failed to go next angle");
  return done.result;
}

export async function apiHubCloseupWizardSaveAll(
  charKey: string,
  sessionId: string
): Promise<CloseupWizardState> {
  const done = await runHubWsJob<CloseupWizardState>({
    charKey,
    payload: { job: "save_all", sessionId },
    onLogLine: () => {},
  });
  if (!done.ok || !done.result) throw new Error(done.error ?? "Failed to save all angles");
  return done.result;
}

export async function apiHubCloseupWizardClose(
  charKey: string,
  sessionId: string
): Promise<void> {
  const done = await runHubWsJob<{ ok: boolean }>({
    charKey,
    payload: { job: "close", sessionId },
    onLogLine: () => {},
  });
  if (!done.ok) throw new Error(done.error ?? "Failed to close closeup wizard");
}

export async function apiNewCharacterGenerate(params: {
  prompt: string;
  name?: string;
}): Promise<{ previewRelPath: string; previewAbsPath?: string }> {
  const res = await fetch(`${API_BASE_URL}/new_character/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    credentials: "omit",
  });
  return readJson<{ previewRelPath: string; previewAbsPath?: string }>(res);
}

type NewCharacterGenerateStreamEvent =
  | { type: "log"; line: string }
  | { type: "done"; previewRelPath: string; previewAbsPath?: string }
  | { type: "error"; detail: unknown };

/** NDJSON stream from `POST /new_character/generate_stream` (live subprocess logs). */
export async function apiNewCharacterGenerateStream(params: {
  prompt: string;
  name?: string;
  onLogLine: (line: string) => void;
  signal?: AbortSignal;
}): Promise<{ previewRelPath: string; previewAbsPath?: string }> {
  const res = await fetch(`${API_BASE_URL}/new_character/generate_stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/x-ndjson, application/json",
    },
    body: JSON.stringify({ prompt: params.prompt, name: params.name }),
    credentials: "omit",
    signal: params.signal,
  });
  if (!res.ok) {
    const t = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(t);
    } catch {
      /* ignore */
    }
    const detail =
      body && typeof body === "object" && body !== null && "detail" in body
        ? (body as { detail: unknown }).detail
        : t;
    const msg = formatFastApiDetailMessage(res.status, detail) ?? `API error ${res.status}`;
    throw new Error(msg);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      const s = line.trim();
      if (!s) continue;
      let obj: NewCharacterGenerateStreamEvent;
      try {
        obj = JSON.parse(s) as NewCharacterGenerateStreamEvent;
      } catch {
        throw new Error(`Invalid stream line: ${s.slice(0, 200)}`);
      }
      if (obj.type === "log") params.onLogLine(obj.line);
      else if (obj.type === "done") {
        return {
          previewRelPath: obj.previewRelPath,
          previewAbsPath: obj.previewAbsPath,
        };
      } else if (obj.type === "error") {
        const msg =
          formatFastApiDetailMessage(500, obj.detail) ?? "Character generation failed.";
        throw new Error(msg);
      }
    }
    if (done) break;
  }
  const tail = buf.trim();
  if (tail) {
    let obj: NewCharacterGenerateStreamEvent;
    try {
      obj = JSON.parse(tail) as NewCharacterGenerateStreamEvent;
    } catch {
      throw new Error("Stream ended without a valid final JSON line.");
    }
    if (obj.type === "done") {
      return {
        previewRelPath: obj.previewRelPath,
        previewAbsPath: obj.previewAbsPath,
      };
    }
    if (obj.type === "error") {
      const msg =
        formatFastApiDetailMessage(500, obj.detail) ?? "Character generation failed.";
      throw new Error(msg);
    }
  }
  throw new Error("Stream ended without done or error.");
}

type NewLocationGenerateStreamEvent =
  | { type: "log"; line: string }
  | { type: "done"; previewRelPath: string }
  | { type: "error"; detail: unknown };

export async function apiNewLocationGenerateStream(params: {
  prompt: string;
  onLogLine: (line: string) => void;
  signal?: AbortSignal;
}): Promise<{ previewRelPath: string }> {
  const res = await fetch(`${API_BASE_URL}/new_location/generate_stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/x-ndjson, application/json",
    },
    body: JSON.stringify({ prompt: params.prompt }),
    credentials: "omit",
    signal: params.signal,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(formatFastApiDetailMessage(res.status, t) ?? `API error ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      const s = line.trim();
      if (!s) continue;
      const obj = JSON.parse(s) as NewLocationGenerateStreamEvent;
      if (obj.type === "log") params.onLogLine(obj.line);
      else if (obj.type === "done") return { previewRelPath: obj.previewRelPath };
      else if (obj.type === "error") throw new Error(formatFastApiDetailMessage(500, obj.detail) ?? "Location generation failed.");
    }
    if (done) break;
  }
  throw new Error("Stream ended without done or error.");
}

export async function apiNewLocationDraftBases(): Promise<{ relPaths: string[] }> {
  const res = await fetch(`${API_BASE_URL}/new_location/draft_bases`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<{ relPaths: string[] }>(res);
}

export async function apiNewLocationAppendUpload(params: {
  file: File;
}): Promise<{ previewRelPath: string }> {
  const fd = new FormData();
  fd.append("file", params.file);
  const res = await fetch(`${API_BASE_URL}/new_location/append_upload`, {
    method: "POST",
    body: fd,
    credentials: "omit",
  });
  return readJson<{ previewRelPath: string }>(res);
}

export async function apiNewLocationFinalize(params: {
  locationName: string;
  relPath: string;
}): Promise<{ ok: boolean; locationKey: string }> {
  const res = await fetch(`${API_BASE_URL}/new_location/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    credentials: "omit",
  });
  return readJson<{ ok: boolean; locationKey: string }>(res);
}

export async function apiNewLocationDiscard(): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE_URL}/new_location/discard`, {
    method: "POST",
    credentials: "omit",
  });
  return readJson<{ ok: boolean }>(res);
}

export async function apiNewLocationRemoveDraft(params: {
  relPath: string;
}): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE_URL}/new_location/remove_draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relPath: params.relPath }),
    credentials: "omit",
  });
  return readJson<{ ok: boolean }>(res);
}

export async function apiNewLocationArchiveBase(params: {
  relPath: string;
}): Promise<{ archivedRelPath: string }> {
  const res = await fetch(`${API_BASE_URL}/new_location/archive_base`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relPath: params.relPath }),
    credentials: "omit",
  });
  return readJson<{ archivedRelPath: string }>(res);
}

export async function apiNewLocationArchiveList(): Promise<{ relPaths: string[] }> {
  const res = await fetch(`${API_BASE_URL}/new_location/archive`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<{ relPaths: string[] }>(res);
}

export async function apiNewLocationImportFromArchive(params: {
  relPath: string;
}): Promise<{ previewRelPath: string }> {
  const res = await fetch(`${API_BASE_URL}/new_location/import_from_archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relPath: params.relPath }),
    credentials: "omit",
  });
  return readJson<{ previewRelPath: string }>(res);
}

export type LocationGalleryItem = {
  itemId: string;
  folderKey: "view" | "lighting";
  relPath: string;
};

export async function apiLocationGallerySplit(locationKey: string): Promise<{
  view: LocationGalleryItem[];
  lighting: LocationGalleryItem[];
  hidden: LocationGalleryItem[];
  baseRelPath: string | null;
}> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(locationKey)}/location/gallery_split`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<{
    view: LocationGalleryItem[];
    lighting: LocationGalleryItem[];
    hidden: LocationGalleryItem[];
    baseRelPath: string | null;
  }>(res);
}

export async function apiLocationGenerate(params: {
  locationKey: string;
  section: "view" | "lighting";
  prompt: string;
}): Promise<{ relPath: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.locationKey)}/location/generate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ section: params.section, prompt: params.prompt }),
      credentials: "omit",
    }
  );
  return readJson<{ relPath: string }>(res);
}

export async function apiLocationHide(params: {
  locationKey: string;
  itemIds: string[];
}): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.locationKey)}/location/hide`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemIds: params.itemIds }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiLocationUnhide(params: {
  locationKey: string;
  itemIds: string[];
}): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.locationKey)}/location/unhide`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemIds: params.itemIds }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiLocationDeleteItems(params: {
  locationKey: string;
  itemIds: string[];
}): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.locationKey)}/location/delete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemIds: params.itemIds }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiLocationGalleryReorder(params: {
  locationKey: string;
  view: string[];
  lighting: string[];
}): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.locationKey)}/location/gallery_reorder`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: params.view, lighting: params.lighting }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiLocationAiEdit(params: {
  locationKey: string;
  section: "view" | "lighting";
  sourceRelPath: string;
  promptText: string;
  maskPngBase64?: string;
}): Promise<{ relPath: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.locationKey)}/location/ai_edit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        section: params.section,
        sourceRelPath: params.sourceRelPath,
        promptText: params.promptText,
        ...(params.maskPngBase64
          ? { maskPngBase64: params.maskPngBase64 }
          : {}),
      }),
      credentials: "omit",
    }
  );
  return readJson<{ relPath: string }>(res);
}

export async function apiLocationOutpaint(params: {
  locationKey: string;
  promptText: string;
}): Promise<{ relPath: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.locationKey)}/location/outpaint`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ promptText: params.promptText }),
      credentials: "omit",
    }
  );
  return readJson<{ relPath: string }>(res);
}

export async function apiNewCharacterSaveUploaded(params: {
  name: string;
  file: File;
}): Promise<{ previewRelPath: string; charKey: string }> {
  const fd = new FormData();
  fd.append("name", params.name);
  fd.append("file", params.file);

  const res = await fetch(`${API_BASE_URL}/new_character/save_uploaded`, {
    method: "POST",
    body: fd,
    credentials: "omit",
  });
  return readJson<{ previewRelPath: string; charKey: string }>(res);
}

export async function apiNewCharacterDraftBases(): Promise<{ relPaths: string[] }> {
  const res = await fetch(`${API_BASE_URL}/new_character/draft_bases`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<{ relPaths: string[] }>(res);
}

export async function apiNewCharacterFinalize(params: {
  characterName: string;
  relPath: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/new_character/finalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      characterName: params.characterName,
      relPath: params.relPath,
    }),
    credentials: "omit",
  });
  await readJson<{ ok: boolean }>(res);
}

export async function apiNewCharacterDiscard(): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/new_character/discard`, {
    method: "POST",
    credentials: "omit",
  });
  await readJson<{ ok: boolean }>(res);
}

export async function apiNewCharacterRemoveDraft(params: {
  relPath: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/new_character/remove_draft`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relPath: params.relPath }),
    credentials: "omit",
  });
  await readJson<{ ok: boolean }>(res);
}

export async function apiNewCharacterArchiveBase(params: {
  relPath: string;
}): Promise<{ archivedRelPath: string }> {
  const res = await fetch(`${API_BASE_URL}/new_character/archive_base`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relPath: params.relPath }),
    credentials: "omit",
  });
  return readJson<{ archivedRelPath: string }>(res);
}

export async function apiNewCharacterArchiveList(): Promise<{
  relPaths: string[];
}> {
  const res = await fetch(`${API_BASE_URL}/new_character/archive`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<{ relPaths: string[] }>(res);
}

export async function apiNewCharacterImportFromArchive(params: {
  relPath: string;
}): Promise<{ previewRelPath: string }> {
  const res = await fetch(`${API_BASE_URL}/new_character/import_from_archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relPath: params.relPath }),
    credentials: "omit",
  });
  return readJson<{ previewRelPath: string }>(res);
}

export async function apiNewCharacterAppendUpload(params: {
  file: File;
}): Promise<{ previewRelPath: string }> {
  const fd = new FormData();
  fd.append("file", params.file);

  const res = await fetch(`${API_BASE_URL}/new_character/append_upload`, {
    method: "POST",
    body: fd,
    credentials: "omit",
  });
  return readJson<{ previewRelPath: string }>(res);
}

// --- WebSocket helpers ---

export function wsUrlForPath(path: string): string {
  const base = API_BASE_URL.replace(/\/$/, "");
  if (base.startsWith("https://")) {
    return "wss://" + base.slice("https://".length) + path;
  }
  if (base.startsWith("http://")) {
    return "ws://" + base.slice("http://".length) + path;
  }
  // Relative base (e.g. "/api"): derive WS URL from current page origin.
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${base}${path}`;
  }
  return `ws://127.0.0.1:8000${path}`;
}

export type WsDoneMessage<T = unknown> = {
  type: "done";
  ok: boolean;
  error?: string;
  result?: T;
};

export function runDetailWsJob<T = unknown>(params: {
  charKey: string;
  pathSuffix: string;
  payload: Record<string, unknown>;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<T>> {
  const path = `/detail/${encodeURIComponent(params.charKey)}${params.pathSuffix}`;
  const url = wsUrlForPath(path);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(params.payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: T;
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        params.onLogLine(data.line);
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<T>);
      }
    };
  });
}

export function runHubWsJob<T = unknown>(params: {
  charKey: string;
  payload: Record<string, unknown>;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<T>> {
  const path = `/hub/${encodeURIComponent(params.charKey)}/closeup_wizard/ws`;
  const url = wsUrlForPath(path);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(params.payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: T;
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        params.onLogLine(data.line);
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<T>);
      }
    };
  });
}

export type CloseupWizardStep = {
  stepKey: "front" | "left" | "right" | "back";
  angleId: number;
  label: string;
};

// --- Detail: pose ---

export type GallerySplitItem = { itemId: string; folderKey: string; relPath: string };
export type GallerySplit = {
  visible: GallerySplitItem[];
  hidden: GallerySplitItem[];
};

export async function apiPoseGallerySplit(
  charKey: string
): Promise<GallerySplit> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose_gallery_items_split`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<GallerySplit>(res);
}

export async function apiPoseAngleItems(
  charKey: string,
  poseKey: string
): Promise<{ angleId: number; relPath: string }[]> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/gallery/${encodeURIComponent(poseKey)}`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<{ angleId: number; relPath: string }[]>(res);
}

export async function apiPoseAnglesOrder(
  charKey: string,
  poseKey: string,
  body: { filenames: string[] }
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/${encodeURIComponent(poseKey)}/angles/order`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export type PoseCatalogItem = { id: number; label: string; promptText: string };

export async function apiPoseCatalog(charKey: string): Promise<PoseCatalogItem[]> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/catalog`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<PoseCatalogItem[]>(res);
}

export type AngleGroup = {
  title: string;
  angleIds: number[];
  angles: { id: number; label: string }[];
};

export async function apiLocationAngleGroups(locationKey: string): Promise<AngleGroup[]> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(locationKey)}/location/angle_groups`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<AngleGroup[]>(res);
}

export async function apiLocationSaveViewCopy(params: {
  locationKey: string;
  blob: Blob;
  filename?: string;
}): Promise<{ relPath: string }> {
  const fd = new FormData();
  fd.append("file", params.blob, params.filename ?? "crop.png");
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.locationKey)}/location/save_view_copy`,
    { method: "POST", body: fd, credentials: "omit" }
  );
  return readJson<{ relPath: string }>(res);
}

type LocationAnglesStreamEvent =
  | { type: "log"; line: string }
  | { type: "done"; ok: boolean }
  | { type: "error"; detail: unknown };

export async function apiLocationGenerateAnglesStream(params: {
  locationKey: string;
  angleIds: number[];
  inputRelPath?: string;
  files?: File[];
  onLogLine: (line: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const fd = new FormData();
  fd.append("angle_ids", JSON.stringify(params.angleIds));
  if (params.inputRelPath) {
    fd.append("input_rel_path", params.inputRelPath);
  }
  for (const f of params.files ?? []) {
    fd.append("files", f);
  }
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.locationKey)}/location/generate_angles`,
    {
      method: "POST",
      body: fd,
      credentials: "omit",
      signal: params.signal,
      headers: {
        accept: "application/x-ndjson, application/json",
      },
    }
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(formatFastApiDetailMessage(res.status, t) ?? `API error ${res.status}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      const s = line.trim();
      if (!s) continue;
      const obj = JSON.parse(s) as LocationAnglesStreamEvent;
      if (obj.type === "log") params.onLogLine(obj.line);
      else if (obj.type === "done") return;
      else if (obj.type === "error")
        throw new Error(formatFastApiDetailMessage(500, obj.detail) ?? "Angle generation failed.");
    }
    if (done) break;
  }
  throw new Error("Stream ended without done or error.");
}

export async function apiPoseAngleGroups(charKey: string): Promise<AngleGroup[]> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/angle_groups`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<AngleGroup[]>(res);
}

export async function apiPoseEnsureBase(charKey: string): Promise<{
  relPath: string | null;
  poseKey: string | null;
}> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/ensure_base`,
    { method: "POST", credentials: "omit" }
  );
  return readJson<{ relPath: string | null; poseKey: string | null }>(res);
}

export async function apiPoseGalleryHidden(
  charKey: string,
  itemIds: string[],
  hidden: boolean
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/gallery/hidden`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemIds, hidden }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiPoseGalleryUiState(
  charKey: string,
  body: { order: string[]; hiddenKeys: string[] }
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/gallery/ui_state`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiPoseFolderRename(
  charKey: string,
  oldKey: string,
  newLabel: string
): Promise<{ newKey: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/folder/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldKey, newLabel }),
      credentials: "omit",
    }
  );
  return readJson<{ newKey: string }>(res);
}

export async function apiPoseFolderDelete(
  charKey: string,
  poseKey: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/folder/delete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poseKey }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiPoseAnglesDelete(
  charKey: string,
  poseKey: string,
  relPaths: string[]
): Promise<{ deleted: number }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/angles/delete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ poseKey, relPaths }),
      credentials: "omit",
    }
  );
  return readJson<{ deleted: number }>(res);
}

export async function apiPoseImportStarting(params: {
  charKey: string;
  file: File;
  poseFolderName?: string;
}): Promise<{ relPath: string; poseKey: string }> {
  const fd = new FormData();
  fd.append("file", params.file);
  if (params.poseFolderName) {
    fd.append("pose_folder_name", params.poseFolderName);
  }
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/pose/import_starting`,
    { method: "POST", body: fd, credentials: "omit" }
  );
  return readJson<{ relPath: string; poseKey: string }>(res);
}

/** Server-side copy from an existing gallery ``relPath`` (avoids large multipart via Next proxy). */
export async function apiPoseImportStartingFromRel(params: {
  charKey: string;
  sourceRelPath: string;
  poseFolderName?: string;
}): Promise<{ relPath: string; poseKey: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/pose/import_starting_from_rel`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceRelPath: params.sourceRelPath,
        pose_folder_name: params.poseFolderName ?? "",
      }),
      credentials: "omit",
    }
  );
  return readJson<{ relPath: string; poseKey: string }>(res);
}

export async function apiUploadStaging(params: {
  charKey: string;
  file: File;
}): Promise<{ relPath: string }> {
  const fd = new FormData();
  fd.append("file", params.file);
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/upload_staging`,
    { method: "POST", body: fd, credentials: "omit" }
  );
  return readJson<{ relPath: string }>(res);
}

// --- Detail: pose references ---

export type PlacedFigureMeta = {
  canvas: { width: number; height: number };
  placement: { x: number; y: number; width: number; height: number };
  figureCropRgbaRelPath?: string;
  figurePlateRelPath?: string;
};

export type PoseReference = {
  id: string;
  referenceRelPath: string;
  keypointRelPath: string;
  label?: string;
  placedFigure?: PlacedFigureMeta;
};

export async function apiPoseReferences(
  charKey: string
): Promise<PoseReference[]> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/references`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<PoseReference[]>(res);
}

export async function apiPoseDeleteReference(
  charKey: string,
  refId: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/pose/reference/${encodeURIComponent(refId)}`,
    { method: "DELETE", credentials: "omit" }
  );
  if (!res.ok) {
    await readJson(res);
  }
}

// --- Global reference library (images + shared keypoints) ---

export type ReferenceImageItem = {
  itemId: string;
  relPath: string;
};

export async function apiReferenceImages(): Promise<ReferenceImageItem[]> {
  const res = await fetch(`${API_BASE_URL}/reference/images`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<ReferenceImageItem[]>(res);
}

export async function apiReferenceKeypoints(): Promise<PoseReference[]> {
  const res = await fetch(`${API_BASE_URL}/reference/keypoints`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<PoseReference[]>(res);
}

export async function apiReferenceImageCommit(
  previewRelPath: string
): Promise<ReferenceImageItem> {
  const res = await fetch(`${API_BASE_URL}/reference/images/commit`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ previewRelPath }),
  });
  const data = await readJson<{ item: ReferenceImageItem }>(res);
  return data.item;
}

export async function apiReferenceImagesReorder(order: string[]): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/reference/images/reorder`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
  if (!res.ok) await readJson(res);
}

export type KeypointFolder = { id: string; name: string; parentId?: string | null };

export type AudioReference = {
  id: string;
  relPath: string;
  label?: string;
  mode?: "audio" | "music";
  tags?: string;
};

export type AudioLayout = {
  folders: KeypointFolder[];
  rootOrder: string[];
  folderOrder: Record<string, string[]>;
  items: AudioReference[];
};

export type KeypointsLayout = {
  folders: KeypointFolder[];
  rootOrder: string[];
  folderOrder: Record<string, string[]>;
  items: PoseReference[];
  videoItems: KeypointVideoReference[];
};

export async function apiReferenceKeypointsLayout(): Promise<KeypointsLayout> {
  const res = await fetch(`${API_BASE_URL}/reference/keypoints/layout`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<KeypointsLayout>(res);
}

export async function apiReferenceKeypointsReorder(
  order: string[]
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/reference/keypoints/reorder`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order }),
  });
  if (!res.ok) await readJson(res);
}

export async function apiReferenceKeypointsReorderRoot(
  order: string[]
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/reference/keypoints/reorder`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "root", order }),
  });
  if (!res.ok) await readJson(res);
}

export async function apiReferenceKeypointsReorderFolder(
  folderId: string,
  order: string[]
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/reference/keypoints/reorder`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "folder", folderId, order }),
  });
  if (!res.ok) await readJson(res);
}

export async function apiReferenceKeypointFolderCreate(
  name: string,
  itemIds: string[],
  parentFolderId?: string | null
): Promise<KeypointFolder> {
  const res = await fetch(`${API_BASE_URL}/reference/keypoints/folders`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      itemIds,
      parentFolderId: parentFolderId ?? null,
    }),
  });
  const data = await readJson<{ folder: KeypointFolder }>(res);
  return data.folder;
}

export async function apiReferenceKeypointFolderRename(
  folderId: string,
  name: string
): Promise<KeypointFolder> {
  const res = await fetch(
    `${API_BASE_URL}/reference/keypoints/folders/${encodeURIComponent(folderId)}`,
    {
      method: "PATCH",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }
  );
  const data = await readJson<{ folder: KeypointFolder }>(res);
  return data.folder;
}

export async function apiReferenceKeypointFolderDelete(
  folderId: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/reference/keypoints/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE", credentials: "omit" }
  );
  if (!res.ok) await readJson(res);
}

export async function apiReferenceImageDelete(id: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/reference/images/${encodeURIComponent(id)}`,
    { method: "DELETE", credentials: "omit" }
  );
  if (!res.ok) await readJson(res);
}

export async function apiReferenceKeypointDelete(id: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/reference/keypoints/${encodeURIComponent(id)}`,
    { method: "DELETE", credentials: "omit" }
  );
  if (!res.ok) await readJson(res);
}

export async function apiReferenceKeypointCopy(id: string): Promise<PoseReference> {
  const res = await fetch(
    `${API_BASE_URL}/reference/keypoints/${encodeURIComponent(id)}/copy`,
    { method: "POST", credentials: "omit" }
  );
  const data = await readJson<{ item: PoseReference }>(res);
  return data.item;
}

export async function apiReferenceKeypointVideoCopy(
  videoId: string
): Promise<KeypointVideoReference> {
  const res = await fetch(
    `${API_BASE_URL}/reference/keypoints/video/${encodeURIComponent(videoId)}/copy`,
    { method: "POST", credentials: "omit" }
  );
  const data = await readJson<{ item: KeypointVideoReference }>(res);
  return data.item;
}

export async function apiReferenceAudioLayout(): Promise<AudioLayout> {
  const res = await fetch(`${API_BASE_URL}/reference/audio/layout`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<AudioLayout>(res);
}

export async function apiReferenceAudioReorderRoot(order: string[]): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/reference/audio/reorder`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "root", order }),
  });
  if (!res.ok) await readJson(res);
}

export async function apiReferenceAudioReorderFolder(
  folderId: string,
  order: string[]
): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/reference/audio/reorder`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "folder", folderId, order }),
  });
  if (!res.ok) await readJson(res);
}

export async function apiReferenceAudioFolderCreate(
  name: string,
  itemIds: string[]
): Promise<KeypointFolder> {
  const res = await fetch(`${API_BASE_URL}/reference/audio/folders`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, itemIds }),
  });
  const data = await readJson<{ folder: KeypointFolder }>(res);
  return data.folder;
}

export async function apiReferenceAudioFolderDelete(folderId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/reference/audio/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE", credentials: "omit" }
  );
  if (!res.ok) await readJson(res);
}

export async function apiReferenceAudioDelete(id: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/reference/audio/${encodeURIComponent(id)}`,
    { method: "DELETE", credentials: "omit" }
  );
  if (!res.ok) await readJson(res);
}

/** Generate ACE-Step audio and register in the global audio gallery. */
export function runReferenceAudioGenerateWsJob(params: {
  mode: "audio" | "music";
  prompt?: string;
  style?: string;
  lyrics?: string;
  duration?: number;
  onLogLine: (line: string) => void;
}): Promise<
  WsDoneMessage<{ item: AudioReference; durationSec: number }>
> {
  const url = wsUrlForPath("/reference/audio/generate/ws");
  const { onLogLine, ...payload } = params;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: { item: AudioReference; durationSec: number };
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        onLogLine(data.line);
        return;
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<{ item: AudioReference; durationSec: number }>);
      }
    };
  });
}

export async function apiReferenceKeypointVideoUpdateStrip(
  videoId: string,
  frameSequence: FrameSequencePayload
): Promise<KeypointVideoReference> {
  const res = await fetch(
    `${API_BASE_URL}/reference/keypoints/video/${encodeURIComponent(videoId)}/frame_sequence`,
    {
      method: "PUT",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frameSequence }),
    }
  );
  return readJson<KeypointVideoReference>(res);
}

export async function apiReferenceKeypointVideoDelete(videoId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/reference/keypoints/video/${encodeURIComponent(videoId)}`,
    { method: "DELETE", credentials: "omit" }
  );
  if (!res.ok) await readJson(res);
}

/** Run SD pose service on a video; resolves with per-frame keypoint video ref. */
export function runReferenceMakeKeypointVideoWsJob(params: {
  videoRelPath: string;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<{ item: KeypointVideoReference }>> {
  const url = wsUrlForPath("/reference/make_keypoint_video/ws");
  const { onLogLine, ...payload } = params;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: { item: KeypointVideoReference };
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        onLogLine(data.line);
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<{ item: KeypointVideoReference }>);
      }
    };
  });
}

/** Generate a Flux2 t2i reference preview. Resolves with the preview rel path. */
export function runReferenceGenerateWsJob(params: {
  promptText: string;
  width?: number;
  height?: number;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<{ previewRelPath: string }>> {
  const url = wsUrlForPath("/reference/generate/ws");
  const { onLogLine, ...payload } = params;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: { previewRelPath: string };
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        onLogLine(data.line);
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<{ previewRelPath: string }>);
      }
    };
  });
}

/** Run the SD pose service on a saved reference image; resolves with the new pair. */
export function runReferenceMakeKeypointWsJob(params: {
  imageRelPath: string;
  cropBox?: { x: number; y: number; width: number; height: number };
  imageWidth?: number;
  imageHeight?: number;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<{ item: PoseReference }>> {
  const url = wsUrlForPath("/reference/make_keypoint/ws");
  const { onLogLine, ...payload } = params;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: { item: PoseReference };
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        onLogLine(data.line);
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<{ item: PoseReference }>);
      }
    };
  });
}

export async function apiReferenceAngleGroups(): Promise<AngleGroup[]> {
  const res = await fetch(`${API_BASE_URL}/reference/angle_groups`, {
    method: "GET",
    credentials: "omit",
  });
  return readJson<AngleGroup[]>(res);
}

/** Generate a new camera angle from a saved reference image; resolves with the new image entry. */
export function runReferenceMakeAngleWsJob(params: {
  imageRelPath: string;
  angleId: number;
  onLogLine: (line: string) => void;
}): Promise<WsDoneMessage<{ item: ReferenceImageItem }>> {
  const url = wsUrlForPath("/reference/make_angle/ws");
  const { onLogLine, ...payload } = params;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket connection failed"));
    };
    ws.onclose = () => {
      if (settled) return;
      settled = true;
      reject(new Error("WebSocket closed before completion"));
    };
    ws.onopen = () => {
      ws.send(JSON.stringify(payload));
    };
    ws.onmessage = (ev) => {
      let data: {
        type?: string;
        line?: string;
        ok?: boolean;
        error?: string;
        result?: { item: ReferenceImageItem };
      };
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (data.type === "log" && typeof data.line === "string") {
        onLogLine(data.line);
      }
      if (data.type === "done") {
        settled = true;
        ws.close();
        resolve(data as WsDoneMessage<{ item: ReferenceImageItem }>);
      }
    };
  });
}

// --- Detail: expression ---

export async function apiExpressionGallerySplit(
  charKey: string
): Promise<GallerySplit> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/expression_gallery_items_split`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<GallerySplit>(res);
}

export async function apiGalleryDownloadZip(
  charKey: string,
  relPaths: string[]
): Promise<Blob> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/gallery/download_zip`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relPaths }),
      credentials: "omit",
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Gallery zip download failed (${res.status})`);
  }
  return res.blob();
}

export async function apiExpressionAngleItems(
  charKey: string,
  exprKey: string
): Promise<{ angleId: number; relPath: string }[]> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/expression/gallery/${encodeURIComponent(exprKey)}`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<{ angleId: number; relPath: string }[]>(res);
}

export async function apiExpressionAnglesOrder(
  charKey: string,
  exprKey: string,
  body: { filenames: string[] }
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/expression/${encodeURIComponent(exprKey)}/angles/order`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export type ExpressionCatalogItem = {
  id: number;
  label: string;
  promptText: string;
};

export async function apiExpressionCatalog(
  charKey: string
): Promise<ExpressionCatalogItem[]> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/expression/catalog`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<ExpressionCatalogItem[]>(res);
}

export async function apiExpressionAngleGroups(
  charKey: string
): Promise<AngleGroup[]> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/expression/angle_groups`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<AngleGroup[]>(res);
}

export async function apiExpressionGalleryHidden(
  charKey: string,
  itemIds: string[],
  hidden: boolean
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/expression/gallery/hidden`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemIds, hidden }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiExpressionGalleryUiState(
  charKey: string,
  body: { order: string[]; hiddenKeys: string[] }
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/expression/gallery/ui_state`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiExpressionFolderRename(
  charKey: string,
  oldKey: string,
  newLabel: string
): Promise<{ newKey: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/expression/folder/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldKey, newLabel }),
      credentials: "omit",
    }
  );
  return readJson<{ newKey: string }>(res);
}

export async function apiExpressionFolderDelete(
  charKey: string,
  exprKey: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/expression/folder/delete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exprKey }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiExpressionAnglesDelete(
  charKey: string,
  exprKey: string,
  relPaths: string[]
): Promise<{ deleted: number }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/expression/angles/delete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exprKey, relPaths }),
      credentials: "omit",
    }
  );
  return readJson<{ deleted: number }>(res);
}

export async function apiExpressionImportStarting(params: {
  charKey: string;
  file: File;
  expressionFolderName?: string;
}): Promise<{ relPath: string; exprKey: string }> {
  const fd = new FormData();
  fd.append("file", params.file);
  if (params.expressionFolderName) {
    fd.append("expression_folder_name", params.expressionFolderName);
  }
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/expression/import_starting`,
    { method: "POST", body: fd, credentials: "omit" }
  );
  return readJson<{ relPath: string; exprKey: string }>(res);
}

/** Server-side copy from an existing gallery ``relPath`` (avoids large multipart via Next proxy). */
export async function apiExpressionImportStartingFromRel(params: {
  charKey: string;
  sourceRelPath: string;
  expressionFolderName?: string;
}): Promise<{ relPath: string; exprKey: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/expression/import_starting_from_rel`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceRelPath: params.sourceRelPath,
        expression_folder_name: params.expressionFolderName ?? "",
      }),
      credentials: "omit",
    }
  );
  return readJson<{ relPath: string; exprKey: string }>(res);
}

// --- Detail: dataset ---

export type BuilderSourceItem = {
  tileId: string;
  sourceKind: string;
  folderKey: string;
  relPath: string;
  /**
   * Pose/expression gallery visibility only (`hidden_*_keys` in gallery_ui_state).
   * When true, the dataset builder client omits this item from `BuilderEntry` state entirely.
   */
  hidden?: boolean;
};

export async function apiDatasetBuilderSources(charKey: string): Promise<{
  poses: BuilderSourceItem[];
  expressions: BuilderSourceItem[];
  /** Flat list in persisted builder order (pose + expression + angle tiles interleaved). */
  items?: BuilderSourceItem[];
  poseStripIds?: string[];
  exprStripIds?: string[];
}> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/builder_sources`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<{
    poses: BuilderSourceItem[];
    expressions: BuilderSourceItem[];
    items?: BuilderSourceItem[];
    poseStripIds?: string[];
    exprStripIds?: string[];
  }>(res);
}

export async function apiDatasetBuilderOrder(
  charKey: string,
  body: {
    tileIds: string[];
    poseStripIds?: string[];
    exprStripIds?: string[];
  }
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/builder_order`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiDatasetFolderNames(charKey: string): Promise<string[]> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/folder_names`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<string[]>(res);
}

export async function apiDatasetImages(
  charKey: string,
  datasetName: string
): Promise<{ relPath: string }[]> {
  const q = new URLSearchParams({ dataset_name: datasetName });
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/images?${q}`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<{ relPath: string }[]>(res);
}

export async function apiDatasetFolderDownloadZip(
  charKey: string,
  datasetName: string
): Promise<Blob> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/${encodeURIComponent(datasetName)}/download_zip`,
    { method: "GET", credentials: "omit" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Dataset zip download failed (${res.status})`);
  }
  return res.blob();
}

export async function apiDatasetExport(params: {
  charKey: string;
  name: string;
  entries: { sourceKind: string; folderKey: string; fileRelPath: string }[];
}): Promise<{ folderName: string; message: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/dataset/export`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: params.name, entries: params.entries }),
      credentials: "omit",
    }
  );
  return readJson<{ folderName: string; message: string }>(res);
}

export async function apiDatasetFolderRename(
  charKey: string,
  oldName: string,
  newLabel: string
): Promise<{ newName: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/folder/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldName, newLabel }),
      credentials: "omit",
    }
  );
  return readJson<{ newName: string }>(res);
}

export async function apiDatasetFolderDuplicate(
  charKey: string,
  sourceName: string,
  newLabel: string
): Promise<{ newName: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/folder/duplicate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceName, newLabel }),
      credentials: "omit",
    }
  );
  return readJson<{ newName: string }>(res);
}

export async function apiDatasetFolderDelete(
  charKey: string,
  name: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/folder/delete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiDatasetImageRename(
  charKey: string,
  datasetName: string,
  oldBasename: string,
  newLabel: string
): Promise<{ newBasename: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/image/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        datasetName,
        oldBasename,
        newLabel,
      }),
      credentials: "omit",
    }
  );
  return readJson<{ newBasename: string }>(res);
}

export async function apiDatasetPreviewAddNoise(
  charKey: string,
  sourceRelPath: string
): Promise<{ previewRelPath: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/preview/add_noise`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRelPath }),
      credentials: "omit",
    }
  );
  return readJson<{ previewRelPath: string }>(res);
}

export async function apiDatasetSavedCommit(params: {
  charKey: string;
  datasetName: string;
  entries: { basename: string; removed: boolean; displayRelPath: string | null }[];
}): Promise<{ message: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/dataset/saved/commit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        datasetName: params.datasetName,
        entries: params.entries,
      }),
      credentials: "omit",
    }
  );
  return readJson<{ message: string }>(res);
}

export async function apiDatasetSavedOrder(
  charKey: string,
  datasetName: string,
  body: { basenames: string[] }
): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/dataset/${encodeURIComponent(datasetName)}/order`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export type SequenceCrop = {
  translateXFrac: number;
  translateYFrac: number;
  scale: number;
};

export type FrameSequenceStripSlot = {
  kind: "image" | "empty";
  relPath?: string;
  crop?: SequenceCrop;
  /** When true (image slots), strip keeps order but modal preview/play skips; timeline treats like empty hold. */
  hidden?: boolean;
};

export type FrameSequenceHiddenItem = {
  relPath: string;
  afterIndex: number;
  crop?: SequenceCrop;
};

export type FrameSequencePayload = {
  sequenceGroupId: string;
  strip: FrameSequenceStripSlot[];
  hidden: FrameSequenceHiddenItem[];
};

export type KeypointVideoStripSlot = FrameSequenceStripSlot & {
  referenceRelPath?: string;
};

export type KeypointVideoReference = {
  id: string;
  videoRelPath: string;
  fps: number;
  frameSequence: FrameSequencePayload & {
    strip: KeypointVideoStripSlot[];
  };
};

export type SequenceGalleryItem = {
  id: string;
  relPath: string;
  crop?: SequenceCrop;
  /** FLF / edited frame sequence (folder of PNGs + optional empties + hidden lane). */
  frameSequence?: FrameSequencePayload;
};

export type SequenceFrameItem = {
  index: number;
  cellId: string;
  relPath: string;
  crop?: SequenceCrop;
  /** Timeline chrome: Frame Sequence group outline. */
  sequenceGroupId?: string;
  /** Timeline: mask cell and skip its 1-24/second label. */
  hidden?: boolean;
};

export type SequencePreviewAspect = "1:1" | "4:3" | "16:9" | "9:16";

export type SequenceManifest = {
  version: number;
  fps: number;
  gallery: SequenceGalleryItem[];
  frames: SequenceFrameItem[];
  /** Preview / crop frame aspect; UI defaults to 16:9 when omitted. */
  previewAspect?: SequencePreviewAspect;
  /**
   * Timeline grid density in the sequence editor only: 1 = show every logical frame column,
   * 2 = show every other column. Not the same as {@link fps} (playback).
   */
  timelineViewStep?: 1 | 2;
};

export async function apiSequenceFolderNames(charKey: string): Promise<string[]> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/sequence/folder_names`,
    { method: "GET", credentials: "omit" }
  );
  const data = await readJson<{ names: string[] }>(res);
  return data.names;
}

/** Persist the display order of sequence folders (drag-reorder). */
export async function apiSequenceFolderOrder(charKey: string, order: string[]): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/sequence/folder_order`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiSequenceCreate(params: {
  charKey: string;
  name: string;
  entries: { sourceKind: string; folderKey: string; fileRelPath: string }[];
}): Promise<{ folderName: string; message: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/sequence/create`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: params.name, entries: params.entries }),
      credentials: "omit",
    }
  );
  return readJson<{ folderName: string; message: string }>(res);
}

export async function apiSequenceGet(
  charKey: string,
  sequenceName: string
): Promise<SequenceManifest> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/sequence/${encodeURIComponent(sequenceName)}`,
    { method: "GET", credentials: "omit" }
  );
  return readJson<SequenceManifest>(res);
}

export async function apiSequencePut(
  charKey: string,
  sequenceName: string,
  manifest: SequenceManifest
): Promise<{ ok: boolean }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/sequence/${encodeURIComponent(sequenceName)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest }),
      credentials: "omit",
    }
  );
  return readJson<{ ok: boolean }>(res);
}

/** Slideshow MP4: one frame per visible timeline cell at ``manifest.fps``. */
export async function apiSequenceExportTimelineMp4Blob(params: {
  charKey: string;
  sequenceName: string;
}): Promise<Blob> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/sequence/${encodeURIComponent(params.sequenceName)}/export_timeline_mp4`,
    { method: "GET", credentials: "omit" }
  );
  if (!res.ok) {
    const rawText = await res.clone().text().catch(() => "");
    const trimmed = rawText.trim();
    const snippet =
      trimmed.length > 2400 ? `${trimmed.slice(0, 2400)}…` : trimmed;
    let body: unknown = null;
    if (trimmed) {
      try {
        body = JSON.parse(trimmed);
      } catch {
        body = null;
      }
    }
    const detail = (body as { detail?: unknown } | null)?.detail;
    const formatted = formatFastApiDetailMessage(res.status, detail);
    if (formatted) throw new Error(formatted);
    throw new Error(formatFailedResponseError(res.status, snippet));
  }
  return res.blob();
}

/** Linear MP4 for one gallery sequence set (24 fps, strip holds / blanks). */
export async function apiSequenceExportGalleryFrameSetMp4Blob(params: {
  charKey: string;
  sequenceName: string;
  galleryId: string;
}): Promise<Blob> {
  const q = new URLSearchParams({ gallery_id: params.galleryId });
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/sequence/${encodeURIComponent(params.sequenceName)}/export_gallery_frame_set_mp4?${q}`,
    { method: "GET", credentials: "omit" }
  );
  if (!res.ok) {
    const rawText = await res.clone().text().catch(() => "");
    const trimmed = rawText.trim();
    const snippet =
      trimmed.length > 2400 ? `${trimmed.slice(0, 2400)}…` : trimmed;
    let body: unknown = null;
    if (trimmed) {
      try {
        body = JSON.parse(trimmed);
      } catch {
        body = null;
      }
    }
    const detail = (body as { detail?: unknown } | null)?.detail;
    const formatted = formatFastApiDetailMessage(res.status, detail);
    if (formatted) throw new Error(formatted);
    throw new Error(formatFailedResponseError(res.status, snippet));
  }
  return res.blob();
}

export async function apiSequenceGenerateFlf(params: {
  charKey: string;
  sequenceName: string;
  startIndex: number;
  endIndex: number;
  length?: number;
}): Promise<{ galleryItem: SequenceGalleryItem }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/sequence/${encodeURIComponent(params.sequenceName)}/generate_flf`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startIndex: params.startIndex,
        endIndex: params.endIndex,
        length: params.length ?? 33,
      }),
      credentials: "omit",
    }
  );
  return readJson<{ galleryItem: SequenceGalleryItem }>(res);
}

export async function apiSequenceGenerateI2v(params: {
  charKey: string;
  sequenceName: string;
  frameIndex: number;
  length?: number;
  width?: number;
  height?: number;
  positivePrompt: string;
}): Promise<{ galleryItem: SequenceGalleryItem }> {
  const body: Record<string, unknown> = {
    frameIndex: params.frameIndex,
    length: params.length ?? 129,
    positivePrompt: params.positivePrompt,
  };
  if (params.width != null) body.width = params.width;
  if (params.height != null) body.height = params.height;
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/sequence/${encodeURIComponent(params.sequenceName)}/generate_i2v`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    }
  );
  return readJson<{ galleryItem: SequenceGalleryItem }>(res);
}

export async function apiSequenceDuplicateAsset(params: {
  charKey: string;
  sequenceName: string;
  sourceRelPath: string;
  subfolder: "gallery" | "cells";
}): Promise<{ relPath: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(params.charKey)}/sequence/${encodeURIComponent(params.sequenceName)}/duplicate_asset`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sourceRelPath: params.sourceRelPath,
        subfolder: params.subfolder,
      }),
      credentials: "omit",
    }
  );
  return readJson<{ relPath: string }>(res);
}

export async function apiSequenceFolderRename(
  charKey: string,
  oldName: string,
  newLabel: string
): Promise<{ newName: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/sequence/folder/rename`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldName, newLabel }),
      credentials: "omit",
    }
  );
  return readJson<{ newName: string }>(res);
}

export async function apiSequenceFolderDuplicate(
  charKey: string,
  sourceName: string,
  newLabel: string
): Promise<{ newName: string }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/sequence/folder/duplicate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceName, newLabel }),
      credentials: "omit",
    }
  );
  return readJson<{ newName: string }>(res);
}

export async function apiSequenceFolderDelete(charKey: string, name: string): Promise<void> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/sequence/folder/delete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
      credentials: "omit",
    }
  );
  await readJson<{ ok: boolean }>(res);
}

export async function apiSequenceRepairPaths(
  charKey: string,
  sequenceName: string
): Promise<{ ok: boolean; rewritten: number }> {
  const res = await fetch(
    `${API_BASE_URL}/detail/${encodeURIComponent(charKey)}/sequence/${encodeURIComponent(sequenceName)}/repair_paths`,
    {
      method: "POST",
      credentials: "omit",
    }
  );
  return readJson<{ ok: boolean; rewritten: number }>(res);
}

