export const getJettonTransfer = (action) =>
  action.jetton_transfer ?? action.jettonTransfer ?? action.JettonTransfer;

export const getTonTransfer = (action) =>
  action.ton_transfer ?? action.tonTransfer ?? action.TonTransfer;

export const isUsdJetton = (symbol) => (symbol ?? "").toLowerCase().includes("usd");

export const getDirection = (trackedRawAddress, sender, recipient) => {
  if (sender === trackedRawAddress) return "OUT";
  if (recipient === trackedRawAddress) return "IN";
  return null;
};

const toJetton = (amount, decimals) => {
  const base = BigInt(amount);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = base / divisor;
  const fraction = base % divisor;
  const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
};

const toTon = (amount) => {
  const nano = BigInt(amount);
  const whole = nano / 1_000_000_000n;
  const fraction = nano % 1_000_000_000n;
  const fracStr = fraction.toString().padStart(9, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
};

const shortAddress = (value) => {
  if (!value) return "JETTON";
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

export const buildSwapSummary = (entries, trackedRawAddress) => {
  const incoming = new Map();
  const outgoing = new Map();
  let hasJetton = false;

  const upsert = (map, entry) => {
    const existing = map.get(entry.assetKey);
    if (existing) {
      existing.rawAmount += entry.rawAmount;
      return;
    }
    map.set(entry.assetKey, { ...entry });
  };

  for (const { action } of entries) {
    if (action.status && action.status !== "ok") continue;
    if (action.type === "JettonTransfer") {
      const transfer = getJettonTransfer(action);
      if (!transfer) continue;
      const sender = transfer.sender?.address;
      const recipient = transfer.recipient?.address;
      const direction = getDirection(trackedRawAddress, sender, recipient);
      if (!direction) continue;
      hasJetton = true;
      const rawAmount = transfer.amount ? String(transfer.amount) : "0";
      const assetKey = transfer.jetton?.address ?? transfer.jetton?.symbol ?? "JETTON";
      const asset = transfer.jetton?.symbol ?? shortAddress(transfer.jetton?.address);
      const entry = {
        assetKey,
        asset,
        rawAmount: BigInt(rawAmount),
        decimals: transfer.jetton?.decimals
      };
      if (direction === "IN") {
        upsert(incoming, entry);
      } else {
        upsert(outgoing, entry);
      }
    }
    if (action.type === "TonTransfer") {
      const transfer = getTonTransfer(action);
      if (!transfer) continue;
      const sender = transfer.sender?.address;
      const recipient = transfer.recipient?.address;
      const direction = getDirection(trackedRawAddress, sender, recipient);
      if (!direction) continue;
      const entry = {
        assetKey: "TON",
        asset: "TON",
        rawAmount: BigInt(transfer.amount ?? "0"),
        decimals: 9
      };
      if (direction === "IN") {
        upsert(incoming, entry);
      } else {
        upsert(outgoing, entry);
      }
    }
  }

  if (hasJetton) {
    const tonOut = outgoing.get("TON");
    if (tonOut && tonOut.rawAmount < 5_000_000n) {
      outgoing.delete("TON");
    }
  }

  if (incoming.size === 0 || outgoing.size === 0) {
    return null;
  }

  const pickLargest = (values) => {
    let best;
    for (const value of values) {
      if (!best || value.rawAmount > best.rawAmount) {
        best = value;
      }
    }
    return best;
  };

  const pickedIncoming = pickLargest(incoming.values());
  const pickedOutgoing = pickLargest(outgoing.values());
  if (!pickedIncoming || !pickedOutgoing) {
    return null;
  }

  let tokenBought = pickedIncoming;
  let tokenSold = pickedOutgoing;

  if (tokenBought.assetKey === tokenSold.assetKey) {
    const altIncoming = [...incoming.values()].find((value) => value.assetKey !== tokenSold.assetKey);
    const altOutgoing = [...outgoing.values()].find((value) => value.assetKey !== tokenBought.assetKey);
    if (altIncoming) {
      tokenBought = altIncoming;
    } else if (altOutgoing) {
      tokenSold = altOutgoing;
    } else {
      return null;
    }
  }

  const formatAmount = (entry) => {
    if (entry.assetKey === "TON") {
      return toTon(entry.rawAmount.toString());
    }
    if (typeof entry.decimals === "number") {
      return toJetton(entry.rawAmount.toString(), entry.decimals);
    }
    return entry.rawAmount.toString();
  };

  return {
    tokenBought: { asset: tokenBought.asset, amount: formatAmount(tokenBought) },
    tokenSold: { asset: tokenSold.asset, amount: formatAmount(tokenSold) }
  };
};
