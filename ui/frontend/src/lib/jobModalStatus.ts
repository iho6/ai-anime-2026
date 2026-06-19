/** Single-line status for JobRunModal next to the spinner (WS log lines can be long). */
export function truncateJobModalStatusLine(raw: string, maxLen = 120): string {
  const s = raw
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1)}…`;
}
