import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMaskBrush,
  createMaskHistory,
  redoMaskHistory,
  resetMaskHistory,
  undoMaskHistory,
} from "../src/objectEditMaskHistory.js";

test("Given a candidate mask When add and remove brushes run Then history undo redo and reset are deterministic", () => {
  const original = Uint8Array.from([
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 255, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ]);
  const start = createMaskHistory({ width: 5, height: 5, pixels: original });
  const added = applyMaskBrush(start, { mode: "add", size: 2, points: [{ x: 0.5, y: 0.5 }, { x: 4.5, y: 0.5 }] });
  assert.ok(added.present.slice(0, 5).every((value) => value === 255));
  assert.equal(added.past.length, 1);

  const removed = applyMaskBrush(added, { mode: "remove", size: 2, points: [{ x: 2.5, y: 2.5 }] });
  assert.equal(removed.present[12], 0);
  assert.equal(removed.past.length, 2);

  const undone = undoMaskHistory(removed);
  assert.equal(undone.present[12], 255);
  assert.deepEqual(redoMaskHistory(undone).present, removed.present);

  const reset = resetMaskHistory(removed);
  assert.deepEqual(reset.present, original);
  assert.deepEqual(undoMaskHistory(reset).present, removed.present);
});

test("Given many brush strokes When history grows Then retained snapshots stay bounded", () => {
  let history = createMaskHistory({ width: 20, height: 1, pixels: new Uint8Array(20) });
  for (let index = 0; index < 20; index += 1) {
    history = applyMaskBrush(history, {
      mode: index % 2 === 0 ? "add" : "remove",
      size: 1,
      points: [{ x: index + 0.5, y: 0.5 }],
    });
  }
  assert.ok(history.past.length <= 12);
});
