import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

test("dashboard selection follows its task id and falls back by row", () => {
  const selection: DashboardSelection = { id: "task-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "task-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `task-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "task-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `task-${index + 1}` })),
    { id: "task-8" },
    { id: "task-9" },
  ]);
  assert.deepEqual(selection, { id: "task-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "task-1" }, { id: "task-2" }]);
  assert.deepEqual(selection, { id: "task-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});
