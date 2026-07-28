/**
 * Proxy-first media URLs for preview (Blender / NLE convention).
 *
 * v4 RMBG preview: one VP9 WebM with a real alpha channel (``.proxy.webm``).
 * No companion matte URL — pairing was done at proxy bake.
 */

import type { TimelineClip } from "../../../lib/api";
import { assetUrlFromRelPath, previewSrcRelPath } from "../../../lib/api";

export type PreviewAlphaKind = "luma" | "alphaChannel";

export type PreviewMediaUrls = {
  /** Preview media URL (color-only, or unified WebM with alpha). */
  rgbUrl: string;
  /**
   * Companion matte URL. Always null for v4 unified ``.proxy.webm`` previews.
   * Legacy masters may still expose ``alphaRelPath`` for export / HTTP fallback.
   */
  alphaUrl: string | null;
  /**
   * How transparency is encoded in the preview media:
   * - "alphaChannel": alpha in the same stream (v4 ``.proxy.webm``)
   * - "luma": opaque companion matte (legacy only; not used for v4 play)
   */
  alphaKind: PreviewAlphaKind;
  /** True when preview is using a proxy rather than master. */
  usingProxy: boolean;
  /** True when master is used only because proxy is missing. */
  missingProxy: boolean;
  /** True when RMBG preview is a single WebM-with-alpha proxy. */
  unifiedAlphaProxy: boolean;
};

/** v4 unified alpha preview proxy (VP9 WebM with alpha_mode). */
export function isUnifiedAlphaProxy(
  clip: Pick<TimelineClip, "proxyRelPath" | "alphaRelPath">
): boolean {
  const proxy = clip.proxyRelPath?.trim() ?? "";
  if (!proxy.toLowerCase().endsWith(".webm")) return false;
  return Boolean(clip.alphaRelPath?.trim());
}

/**
 * Legacy companion mattes (.alpha.mp4 / .alpha.mkv) store alpha in luminance.
 * Unified WebM uses a real alpha channel in the same file.
 */
export function alphaKindForRelPath(alphaRel: string): PreviewAlphaKind {
  const lower = alphaRel.toLowerCase();
  return lower.endsWith(".alpha.mp4") || lower.endsWith(".alpha.mkv")
    ? "luma"
    : "alphaChannel";
}

/** Resolve preview media preferring proxies; never dual-stream for v4 WebM. */
export function resolvePreviewMedia(clip: TimelineClip): PreviewMediaUrls {
  const hasProxy = Boolean(clip.proxyRelPath?.trim());
  const rgbRel = previewSrcRelPath(clip);
  const unified = isUnifiedAlphaProxy(clip);

  // v4: single file carries alpha — do not attach a companion matte URL
  // (stale proxyAlphaRelPath from v3 pairs is ignored until ensure regenerates).
  if (unified) {
    return {
      rgbUrl: assetUrlFromRelPath(rgbRel),
      alphaUrl: null,
      alphaKind: "alphaChannel",
      usingProxy: true,
      missingProxy: false,
      unifiedAlphaProxy: true,
    };
  }

  // No usable unified proxy yet: HTTP RGBA / master paths may use alphaRelPath
  // for server-side frames, but preview play must not free-run a matte video.
  const alphaRel = clip.alphaRelPath?.trim() || null;

  return {
    rgbUrl: assetUrlFromRelPath(rgbRel),
    alphaUrl: null,
    alphaKind: alphaRel ? alphaKindForRelPath(alphaRel) : "alphaChannel",
    usingProxy: hasProxy,
    missingProxy:
      clip.type === "video" && !hasProxy && Boolean(clip.srcRelPath?.trim()),
    unifiedAlphaProxy: false,
  };
}

/** Any video on the timeline is still waiting on proxy generation. */
export function timelineHasMissingProxies(
  clips: ReadonlyArray<Pick<TimelineClip, "type" | "proxyRelPath" | "srcRelPath">>
): boolean {
  return clips.some(
    (c) => c.type === "video" && Boolean(c.srcRelPath?.trim()) && !c.proxyRelPath?.trim()
  );
}
