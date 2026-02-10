import test from "node:test";
import assert from "node:assert/strict";

import { diffAccountSubscriptions, splitIntoBatches } from "../src/webhook-sync.js";

test("diffAccountSubscriptions calculates subscribe/unsubscribe sets", () => {
  const diff = diffAccountSubscriptions(["0:a", "0:b", "0:c"], ["0:b", "0:d"]);
  assert.deepEqual(diff.toSubscribe, ["0:a", "0:c"]);
  assert.deepEqual(diff.toUnsubscribe, ["0:d"]);
});

test("splitIntoBatches chunks by fixed size", () => {
  const batches = splitIntoBatches([1, 2, 3, 4, 5], 2);
  assert.deepEqual(batches, [
    [1, 2],
    [3, 4],
    [5]
  ]);
});

test("diffAccountSubscriptions keeps shared address when one user deleted", () => {
  const dbWithSharedAddress = ["0:shared", "0:shared", "0:other"];
  const remote = ["0:shared", "0:old"];
  const diff = diffAccountSubscriptions(dbWithSharedAddress, remote);
  assert.deepEqual(diff.toSubscribe, ["0:other"]);
  assert.deepEqual(diff.toUnsubscribe, ["0:old"]);
});
