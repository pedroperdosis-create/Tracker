import test from "node:test";
import assert from "node:assert/strict";

import { buildSwapSummary, getDirection } from "../src/swap.js";

test("SwapSummary: jetton OUT + TON IN => swap", () => {
  const walletRaw = "0:wallet";
  const entries = [
    {
      index: 0,
      action: {
        type: "JettonTransfer",
        status: "ok",
        JettonTransfer: {
          amount: "1000000",
          jetton: { symbol: "TEST", decimals: 6 },
          sender: { address: walletRaw },
          recipient: { address: "0:other" }
        }
      }
    },
    {
      index: 1,
      action: {
        type: "TonTransfer",
        status: "ok",
        TonTransfer: {
          amount: "2000000000",
          sender: { address: "0:router" },
          recipient: { address: walletRaw }
        }
      }
    }
  ];
  const summary = buildSwapSummary(entries, walletRaw);
  assert.ok(summary);
  assert.equal(summary.tokenSold?.asset, "TEST");
  assert.equal(summary.tokenSold?.amount, "1");
  assert.equal(summary.tokenBought?.asset, "TON");
  assert.equal(summary.tokenBought?.amount, "2");
});

test("Direction: internal transfer between tracked wallets", () => {
  const walletA = "0:walletA";
  const walletB = "0:walletB";
  assert.equal(getDirection(walletA, walletA, walletB), "OUT");
  assert.equal(getDirection(walletB, walletA, walletB), "IN");
});

test("SwapSummary: simple USDT transfer is not swap", () => {
  const walletRaw = "0:wallet";
  const entries = [
    {
      index: 0,
      action: {
        type: "JettonTransfer",
        status: "ok",
        JettonTransfer: {
          amount: "200000",
          jetton: { symbol: "USD₮", decimals: 6 },
          sender: { address: "0:other" },
          recipient: { address: walletRaw }
        }
      }
    }
  ];
  const summary = buildSwapSummary(entries, walletRaw);
  assert.equal(summary, null);
});

test("SwapSummary: one-sided pseudo swap is not swap", () => {
  const walletRaw = "0:wallet";
  const entries = [
    {
      index: 0,
      action: {
        type: "JettonTransfer",
        status: "ok",
        JettonTransfer: {
          amount: "1000000",
          jetton: { symbol: "AAA", decimals: 6 },
          sender: { address: walletRaw },
          recipient: { address: "0:router" }
        }
      }
    }
  ];
  const summary = buildSwapSummary(entries, walletRaw);
  assert.equal(summary, null);
});

test("SwapSummary: jetton OUT + jetton IN (different assets) => swap", () => {
  const walletRaw = "0:wallet";
  const entries = [
    {
      index: 0,
      action: {
        type: "JettonTransfer",
        status: "ok",
        JettonTransfer: {
          amount: "1000000",
          jetton: { symbol: "AAA", decimals: 6 },
          sender: { address: walletRaw },
          recipient: { address: "0:router" }
        }
      }
    },
    {
      index: 1,
      action: {
        type: "JettonTransfer",
        status: "ok",
        JettonTransfer: {
          amount: "500000",
          jetton: { symbol: "BBB", decimals: 6 },
          sender: { address: "0:router" },
          recipient: { address: walletRaw }
        }
      }
    }
  ];
  const summary = buildSwapSummary(entries, walletRaw);
  assert.ok(summary);
  assert.equal(summary.tokenSold?.asset, "AAA");
  assert.equal(summary.tokenBought?.asset, "BBB");
});

test("SwapSummary: TON OUT + jetton IN => swap", () => {
  const walletRaw = "0:wallet";
  const entries = [
    {
      index: 0,
      action: {
        type: "TonTransfer",
        status: "ok",
        TonTransfer: {
          amount: "1500000000",
          sender: { address: walletRaw },
          recipient: { address: "0:router" }
        }
      }
    },
    {
      index: 1,
      action: {
        type: "JettonTransfer",
        status: "ok",
        JettonTransfer: {
          amount: "900000",
          jetton: { symbol: "JET", decimals: 6 },
          sender: { address: "0:router" },
          recipient: { address: walletRaw }
        }
      }
    }
  ];
  const summary = buildSwapSummary(entries, walletRaw);
  assert.ok(summary);
  assert.equal(summary.tokenSold?.asset, "TON");
  assert.equal(summary.tokenSold?.amount, "1.5");
  assert.equal(summary.tokenBought?.asset, "JET");
  assert.equal(summary.tokenBought?.amount, "0.9");
});

test("SwapSummary: internal transfer is not swap", () => {
  const walletRaw = "0:wallet";
  const entries = [
    {
      index: 0,
      action: {
        type: "TonTransfer",
        status: "ok",
        TonTransfer: {
          amount: "1000000000",
          sender: { address: walletRaw },
          recipient: { address: "0:other" }
        }
      }
    }
  ];
  const summary = buildSwapSummary(entries, walletRaw);
  assert.equal(summary, null);
});

test("SwapSummary: ignores small TON fee when jetton transfers present", () => {
  const walletRaw = "0:wallet";
  const entries = [
    {
      index: 0,
      action: {
        type: "TonTransfer",
        status: "ok",
        TonTransfer: {
          amount: "1000000",
          sender: { address: walletRaw },
          recipient: { address: "0:router" }
        }
      }
    },
    {
      index: 1,
      action: {
        type: "JettonTransfer",
        status: "ok",
        JettonTransfer: {
          amount: "1000000",
          jetton: { symbol: "AAA", decimals: 6 },
          sender: { address: walletRaw },
          recipient: { address: "0:router" }
        }
      }
    },
    {
      index: 2,
      action: {
        type: "JettonTransfer",
        status: "ok",
        JettonTransfer: {
          amount: "2000000",
          jetton: { symbol: "BBB", decimals: 6 },
          sender: { address: "0:router" },
          recipient: { address: walletRaw }
        }
      }
    }
  ];
  const summary = buildSwapSummary(entries, walletRaw);
  assert.ok(summary);
  assert.equal(summary.tokenSold?.asset, "AAA");
  assert.equal(summary.tokenBought?.asset, "BBB");
});
