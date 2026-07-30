import assert from "node:assert/strict";
import test from "node:test";

import { pathExists, withViteHarness } from "./object-aware-mcp-harness.mjs";

test("Given port allocation fails before Vite starts When the harness unwinds Then its temporary canvas directory is removed", async () => {
  let canvasDir = null;
  const bindError = Object.assign(new Error("forced bind failure"), { code: "EPERM" });

  await assert.rejects(
    withViteHarness(async () => {}, {
      allocatePort: async (context) => {
        canvasDir = context.canvasDir;
        throw bindError;
      },
      prefix: "cowart-harness-cleanup-",
    }),
    (error) => error === bindError
  );

  assert.equal(typeof canvasDir, "string");
  assert.equal(await pathExists(canvasDir), false);
});
