import test from "node:test";
import assert from "node:assert/strict";

import { createEmptyProcessResult } from "../src/process-result.js";

test("createEmptyProcessResult returns safe defaults", () => {
  assert.deepEqual(createEmptyProcessResult(), { newCount: 0, notifiedCount: 0 });
});
