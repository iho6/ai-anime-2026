/**
 * Unit tests for folderSelection helpers (run: npx --yes tsx tests/folderSelection.test.mts)
 */
import assert from "node:assert/strict";
import {
  collectFolderLeafIds,
  folderSelectionState,
  toggleFolderSelection,
} from "../ui/frontend/src/lib/folderSelection.ts";

const layout = {
  folderOrder: {
    root: ["folder:a", "leaf-1", "folder:b"],
    a: ["leaf-2", "folder:nested"],
    nested: ["leaf-3", "leaf-4"],
    b: ["leaf-5"],
  },
};

const isLeaf = (tok: string) => tok.startsWith("leaf-");

// Nested folder collects all descendant leaves.
{
  const leaves = collectFolderLeafIds("a", layout, isLeaf);
  assert.deepEqual(leaves.sort(), ["leaf-2", "leaf-3", "leaf-4"]);
}

// Root folder skips nested folder tokens and recurses.
{
  const leaves = collectFolderLeafIds("root", layout, isLeaf);
  assert.deepEqual(leaves.sort(), ["leaf-1", "leaf-2", "leaf-3", "leaf-4", "leaf-5"]);
}

// Empty folder → no selection state.
{
  const emptyLayout = { folderOrder: { empty: [] } };
  const state = folderSelectionState("empty", emptyLayout, new Set(), isLeaf);
  assert.deepEqual(state, { checked: false, indeterminate: false });
}

// Partial selection → indeterminate.
{
  const selected = new Set(["leaf-2", "leaf-3"]);
  const state = folderSelectionState("a", layout, selected, isLeaf);
  assert.deepEqual(state, { checked: false, indeterminate: true });
}

// Full selection → checked.
{
  const selected = new Set(["leaf-2", "leaf-3", "leaf-4"]);
  const state = folderSelectionState("a", layout, selected, isLeaf);
  assert.deepEqual(state, { checked: true, indeterminate: false });
}

// Toggle on adds all leaves; toggle off removes them.
{
  const base = new Set<string>(["leaf-1"]);
  const on = toggleFolderSelection("b", layout, base, true, isLeaf);
  assert.ok(on.has("leaf-1"));
  assert.ok(on.has("leaf-5"));
  const off = toggleFolderSelection("b", layout, on, false, isLeaf);
  assert.ok(off.has("leaf-1"));
  assert.ok(!off.has("leaf-5"));
}

console.log("folderSelection.test: ok");
