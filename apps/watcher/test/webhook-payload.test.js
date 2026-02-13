import test from "node:test";
import assert from "node:assert/strict";

import { extractWebhookHint } from "../src/webhook-payload.js";

test("extractWebhookHint picks direct fields", () => {
  const hint = extractWebhookHint({ tx_hash: "tx1", account_id: "0:abc", event_id: "ev1" });
  assert.equal(hint.txHash, "tx1");
  assert.equal(hint.accountId, "0:abc");
  assert.equal(hint.eventId, "ev1");
});

test("extractWebhookHint picks nested fields", () => {
  const hint = extractWebhookHint({ params: { txHash: "tx2", address: "0:def" }, event: { id: "ev2" } });
  assert.equal(hint.txHash, "tx2");
  assert.equal(hint.accountId, "0:def");
  assert.equal(hint.eventId, "ev2");
});
