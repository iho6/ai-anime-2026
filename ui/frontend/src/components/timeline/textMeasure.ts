import type { TimelineText } from "../../lib/api";
import {
  ensureTimelineFontLoaded,
  timelineFontCssFamily,
} from "../../lib/timelineFonts";

/** Padding around text inside the clip box, in artboard units. */
export const TEXT_CLIP_PADDING_ARTBOARD = 16;

const LINE_HEIGHT = 1.2;
const MIN_NATURAL_SIZE = 48;

function wrapLines(
  ctx: CanvasRenderingContext2D,
  content: string,
  maxWidth?: number
): string[] {
  const paragraphs = content.split("\n");
  if (!maxWidth || maxWidth <= 0) return paragraphs.length ? paragraphs : [""];

  const out: string[] = [];
  for (const para of paragraphs) {
    if (!para) {
      out.push("");
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = "";
    for (const word of words) {
      const trial = line + word;
      if (ctx.measureText(trial).width > maxWidth && line) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = trial;
      }
    }
    out.push(line.trimEnd());
  }
  return out.length ? out : [""];
}

function measureWithCanvas(
  text: TimelineText,
  cssFamily: string,
  options?: { maxWidth?: number }
): { width: number; height: number } {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { width: MIN_NATURAL_SIZE, height: MIN_NATURAL_SIZE };
  }

  const fontSize = Math.max(8, text.fontSize);
  ctx.font = `${text.fontStyle} ${text.fontWeight} ${fontSize}px ${cssFamily}, sans-serif`;

  const content = text.content || " ";
  const lines = wrapLines(ctx, content, options?.maxWidth);
  let maxW = 0;
  for (const line of lines) {
    const m = ctx.measureText(line || " ");
    maxW = Math.max(maxW, m.width);
  }

  const lineHeightPx = fontSize * LINE_HEIGHT;
  const textH = lines.length * lineHeightPx;
  const pad = TEXT_CLIP_PADDING_ARTBOARD * 2;

  return {
    width: Math.max(MIN_NATURAL_SIZE, Math.ceil(maxW + pad)),
    height: Math.max(MIN_NATURAL_SIZE, Math.ceil(textH + pad)),
  };
}

/** Sync estimate (font may not be loaded yet). Used when creating clips. */
export function estimateTextClipNaturalSize(
  text: TimelineText,
  options?: { maxWidth?: number }
): { width: number; height: number } {
  return measureWithCanvas(text, timelineFontCssFamily(text.fontFamilyId), options);
}

/** Measure text bounds in artboard units after loading the font. */
export async function measureTextClipNaturalSize(
  text: TimelineText,
  options?: { maxWidth?: number }
): Promise<{ width: number; height: number }> {
  const cssFamily = await ensureTimelineFontLoaded(text.fontFamilyId, text.fontWeight);
  return measureWithCanvas(text, cssFamily, options);
}
