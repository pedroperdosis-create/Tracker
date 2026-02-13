import test from "node:test";
import assert from "node:assert/strict";

import { createDebouncedInFlightQueue } from "../src/ws-queue.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("createDebouncedInFlightQueue debounces and avoids parallel work", async () => {
  let running = 0;
  let maxRunning = 0;
  let calls = 0;

  const queue = createDebouncedInFlightQueue(40, async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    calls += 1;
    await sleep(30);
    running -= 1;
  });

  queue.trigger("wallet", { id: 1 });
  queue.trigger("wallet", { id: 2 });
  queue.trigger("wallet", { id: 3 });

  await sleep(120);

  assert.equal(calls, 1);
  assert.equal(maxRunning, 1);

  queue.trigger("wallet", { id: 4 });
  queue.trigger("wallet", { id: 5 });

  await sleep(120);

  assert.equal(calls, 2);
  assert.equal(maxRunning, 1);
});
