import assert from "node:assert/strict";
import test from "node:test";

import { buildObjectEditLineage } from "../src/objectEditLineage.js";

test("Given object actions variants and a winner When lineage is projected Then it is read-only ordered and deduplicated", () => {
  const group = {
    id: "grid:one",
    sourceShapeId: "shape:source",
    count: 4,
    createdAt: "2026-07-20T00:01:00.000Z",
    winnerHolderId: "shape:v2",
    selectedAt: "2026-07-20T00:03:00.000Z",
  };
  const events = buildObjectEditLineage([
    {
      id: "shape:v1",
      props: { status: "filled" },
      meta: {
        cowartObjectAction: { sourceShapeId: "shape:source", operation: "modify", requestedAt: "2026-07-20T00:00:00.000Z" },
        cowartVariantGroup: group,
      },
    },
    { id: "shape:v2", props: { status: "filled" }, meta: { cowartVariantGroup: group } },
    {
      id: "shape:extract",
      meta: { cowartObjectEdit: { sourceShapeId: "shape:source", operation: "extract", timestamp: "2026-07-20T00:02:00.000Z" } },
    },
  ], "shape:source");

  assert.deepEqual(events.map((event) => event.kind), [
    "source",
    "object_action",
    "variant_grid",
    "object_result",
    "variant_winner",
  ]);
  assert.equal(events.filter((event) => event.kind === "variant_grid").length, 1);
  assert.equal(events.filter((event) => event.kind === "variant_winner").length, 1);
});
