export type ContainerId = string;

export type ReorderInput = {
  activeId: string;
  overId: string | null;
  sourceContainerId: ContainerId;
  targetContainerId: ContainerId;
  containers: Record<ContainerId, string[]>;
  selectedIds: Set<string>;
};

export type ReorderOutput = {
  movingIds: string[];
  containers: Record<ContainerId, string[]>;
};

function uniqPreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of items) {
    if (!x) continue;
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

export function computeMovingIds(params: {
  activeId: string;
  selectedIds: Set<string>;
  sourceIds: string[];
}): string[] {
  const { activeId, selectedIds, sourceIds } = params;
  if (selectedIds.has(activeId)) {
    // Move selection as a contiguous block, preserving original order in the source list.
    return sourceIds.filter((id) => selectedIds.has(id));
  }
  // If active is not selected, drag only active (even if other items are selected).
  return [activeId];
}

export function reorderInsertBefore(input: ReorderInput): ReorderOutput {
  const { activeId, overId, sourceContainerId, targetContainerId } = input;
  const containers: Record<ContainerId, string[]> = {};
  for (const [cid, ids] of Object.entries(input.containers)) {
    containers[cid] = uniqPreserveOrder([...ids]);
  }

  const sourceIds = containers[sourceContainerId] ?? [];
  const movingIds = computeMovingIds({
    activeId,
    selectedIds: input.selectedIds,
    sourceIds,
  });
  const movingSet = new Set(movingIds);

  // Remove moving from all containers (safe for cross-container).
  for (const cid of Object.keys(containers)) {
    containers[cid] = containers[cid].filter((id) => !movingSet.has(id));
  }

  const targetIds = containers[targetContainerId] ?? [];
  let insertIdx = targetIds.length;
  if (overId) {
    const idx = targetIds.indexOf(overId);
    if (idx >= 0) insertIdx = idx;
  }
  const next = [...targetIds.slice(0, insertIdx), ...movingIds, ...targetIds.slice(insertIdx)];
  containers[targetContainerId] = uniqPreserveOrder(next);

  return { movingIds, containers };
}

export function reorderInsertBeforeOrAfter(
  input: ReorderInput & { insertAfter: boolean }
): ReorderOutput {
  const { activeId, overId, sourceContainerId, targetContainerId, insertAfter } =
    input;
  const containers: Record<ContainerId, string[]> = {};
  for (const [cid, ids] of Object.entries(input.containers)) {
    containers[cid] = uniqPreserveOrder([...ids]);
  }

  const sourceIds = containers[sourceContainerId] ?? [];
  const movingIds = computeMovingIds({
    activeId,
    selectedIds: input.selectedIds,
    sourceIds,
  });
  const movingSet = new Set(movingIds);

  for (const cid of Object.keys(containers)) {
    containers[cid] = containers[cid].filter((id) => !movingSet.has(id));
  }

  const targetIds = containers[targetContainerId] ?? [];
  let insertIdx = targetIds.length;
  if (overId) {
    const idx = targetIds.indexOf(overId);
    if (idx >= 0) insertIdx = idx + (insertAfter ? 1 : 0);
  }
  const next = [
    ...targetIds.slice(0, insertIdx),
    ...movingIds,
    ...targetIds.slice(insertIdx),
  ];
  containers[targetContainerId] = uniqPreserveOrder(next);
  return { movingIds, containers };
}

