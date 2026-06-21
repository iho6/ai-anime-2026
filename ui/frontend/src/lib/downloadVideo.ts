import {
  API_BASE_URL,
  formatFailedResponseError,
  formatFastApiDetailMessage,
} from "./api";

export function sanitizeDownloadBaseName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "video";
}

export function filenameFromResponse(res: Response, fallbackBase: string): string {
  const cd = res.headers.get("Content-Disposition") ?? "";
  const star = /filename\*=UTF-8''([^;\s]+)/i.exec(cd);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].replace(/"/g, ""));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";\n]+)"?/i.exec(cd);
  if (plain?.[1]) {
    return plain[1].trim();
  }
  const ct = (res.headers.get("Content-Type") ?? "").toLowerCase();
  const ext = ct.includes("webm") ? "webm" : "mp4";
  return `${sanitizeDownloadBaseName(fallbackBase)}.${ext}`;
}

export function triggerVideoDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function readVideoFetchError(res: Response): Promise<never> {
  const rawText = await res.clone().text().catch(() => "");
  const trimmed = rawText.trim();
  const snippet = trimmed.length > 2400 ? `${trimmed.slice(0, 2400)}…` : trimmed;
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

export async function downloadVideoFromResponse(
  res: Response,
  fallbackBase: string
): Promise<void> {
  if (!res.ok) {
    await readVideoFetchError(res);
  }
  const blob = await res.blob();
  const filename = filenameFromResponse(res, fallbackBase);
  triggerVideoDownload(blob, filename);
}

export async function fetchVideoExport(url: string, fallbackBase: string): Promise<void> {
  const res = await fetch(url, { method: "GET", credentials: "omit" });
  await downloadVideoFromResponse(res, fallbackBase);
}

export async function dataUrlToStagingFile(dataUrl: string, index: number): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const pad = String(index).padStart(5, "0");
  return new File([blob], `motion_frame_${pad}.png`, { type: "image/png" });
}

export async function apiExportFramesVideo(params: {
  relPaths: string[];
  fps: number;
  filenameBase?: string;
}): Promise<void> {
  const res = await fetch(`${API_BASE_URL}/export/frames_video`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      relPaths: params.relPaths,
      fps: params.fps,
      filenameBase: params.filenameBase,
    }),
    credentials: "omit",
  });
  await downloadVideoFromResponse(res, params.filenameBase ?? "frames");
}
