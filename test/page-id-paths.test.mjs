import assert from "node:assert/strict";
import test from "node:test";

import { cowartPageDirName } from "../shared/cowart-page-assets.mjs";
import { pageDirName as mcpPageDirName } from "../mcp/paths.mjs";
import { pageDirName as serverPageDirName } from "../server/page-snapshots.mjs";

const pageDirFunctions = [cowartPageDirName, mcpPageDirName, serverPageDirName];

test("Given safe page ids When page directories are derived Then server and MCP preserve the same path segment", () => {
  for (const pageDirName of pageDirFunctions) {
    assert.equal(pageDirName("page:one_safe-1.2~draft"), "one_safe-1.2~draft");
  }
});

test("Given malformed or non-round-tripping page ids When page directories are derived Then every path boundary rejects them", () => {
  const unsafePageIds = ["page:", "page:.", "page:..", "page:a/b", "page:a\\b", "page:a b", "page:%2e%2e", "page:\uD800", "other:one"];
  for (const pageDirName of pageDirFunctions) {
    for (const pageId of unsafePageIds) {
      assert.throws(
        () => pageDirName(pageId),
        (error) => error?.code === "invalid_page_id" && error?.status === 400,
        `${pageDirName.name} accepted ${pageId}`
      );
    }
  }
});
