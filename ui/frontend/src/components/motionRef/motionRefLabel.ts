/** Strip the default KiMoD prompt prefix so action text is visible in names/labels. */
const PERSON_IS_PREFIX = /^a person is\s+/i;

export function stripMotionPersonIsPrefix(text: string): string {
  return String(text || "").replace(PERSON_IS_PREFIX, "").trim();
}

/** Gallery / context label: stripped segment text, else motionKey. */
export function motionRefDisplayLabel(
  segmentText: string | undefined | null,
  motionKey: string,
  maxLen = 28
): string {
  const stripped = stripMotionPersonIsPrefix(segmentText || "");
  const raw = stripped || motionKey || "motion";
  return raw.slice(0, maxLen);
}

/** Folder/auto name from first segment (stripped, truncated). */
export function motionRefAutoNameFromSegment(segmentText: string, maxLen = 40): string {
  const stripped = stripMotionPersonIsPrefix(segmentText);
  return (stripped || "motion").slice(0, maxLen);
}
