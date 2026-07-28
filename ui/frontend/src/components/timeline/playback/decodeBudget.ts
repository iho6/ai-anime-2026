/**
 * Rotating concurrent <video>.play() budget so stacked clips don't permanently
 * lose decode slots (fixed top-N lottery).
 */

export const MAX_ACTIVE_VIDEO_DECODES = 4;

/** Frames of timeline clock between budget rotations. */
export const PLAY_BUDGET_ROTATION_FRAMES = 6;

export function playBudgetRotationEpoch(
  timelineFrame: number,
  framesPerRotation = PLAY_BUDGET_ROTATION_FRAMES
): number {
  const step = Math.max(1, framesPerRotation);
  return Math.floor(Math.max(0, timelineFrame) / step);
}

/**
 * Assign up to `maxSlots` play slots among clipIds, rotating which clips win
 * as `rotationEpoch` advances. Duplicate ids are collapsed first.
 */
export function assignPlaySlots(
  clipIds: readonly string[],
  maxSlots: number,
  rotationEpoch: number
): Set<string> {
  const ids: string[] = [];
  for (const id of clipIds) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  const limit = Math.max(0, Math.floor(maxSlots));
  if (ids.length === 0 || limit === 0) return new Set();
  if (ids.length <= limit) return new Set(ids);
  const start =
    ((rotationEpoch % ids.length) + ids.length) % ids.length;
  const slots = new Set<string>();
  for (let i = 0; i < limit; i++) {
    slots.add(ids[(start + i) % ids.length]!);
  }
  return slots;
}
