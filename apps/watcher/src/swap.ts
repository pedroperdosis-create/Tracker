export type TonApiAction = {
  action_id?: string;
  type: string;
  status?: string;
  simple_preview?: {
    name?: string;
    description?: string;
    value_usd?: number;
  };
  ton_transfer?: {
    amount?: string;
    sender?: { address?: string; name?: string };
    recipient?: { address?: string; name?: string };
    is_internal?: boolean;
    comment?: string;
    amount_usd?: number;
  };
  tonTransfer?: {
    amount?: string;
    sender?: { address?: string; name?: string };
    recipient?: { address?: string; name?: string };
    is_internal?: boolean;
    comment?: string;
    amount_usd?: number;
  };
  TonTransfer?: {
    amount?: string;
    sender?: { address?: string; name?: string };
    recipient?: { address?: string; name?: string };
    is_internal?: boolean;
    comment?: string;
    amount_usd?: number;
  };
  jetton_transfer?: {
    amount?: string;
    jetton?: { symbol?: string; decimals?: number; address?: string };
    sender?: { address?: string; name?: string };
    recipient?: { address?: string; name?: string };
    amount_usd?: number;
  };
  jettonTransfer?: {
    amount?: string;
    jetton?: { symbol?: string; decimals?: number; address?: string };
    sender?: { address?: string; name?: string };
    recipient?: { address?: string; name?: string };
    amount_usd?: number;
  };
  JettonTransfer?: {
    amount?: string;
    jetton?: { symbol?: string; decimals?: number; address?: string };
    sender?: { address?: string; name?: string };
    recipient?: { address?: string; name?: string };
    amount_usd?: number;
  };
  nft_transfer?: {
    sender?: { address?: string; name?: string };
    recipient?: { address?: string; name?: string };
    nft?: { name?: string; collection?: { name?: string } };
  };
};

export type ActionEntry = {
  action: TonApiAction;
  index: number;
};

export type SwapToken = {
  asset: string;
  amount: string;
};

export type SwapSummary = {
  tokenBought?: SwapToken;
  tokenSold?: SwapToken;
  quote?: SwapToken;
};

export const getJettonTransfer = (action: TonApiAction) =>
  action.jetton_transfer ?? action.jettonTransfer ?? action.JettonTransfer;

export const getTonTransfer = (action: TonApiAction) =>
  action.ton_transfer ?? action.tonTransfer ?? action.TonTransfer;

export const isUsdJetton = (symbol?: string) => (symbol ?? "").toLowerCase().includes("usd");

export const getDirection = (trackedRawAddress: string, sender?: string, recipient?: string) => {
  if (sender === trackedRawAddress) return "OUT" as const;
  if (recipient === trackedRawAddress) return "IN" as const;
  return null;
};

const toJetton = (amount: string, decimals: number) => {
  const base = BigInt(amount);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = base / divisor;
  const fraction = base % divisor;
  const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
};

const toTon = (amount: string) => {
  const nano = BigInt(amount);
  const whole = nano / 1_000_000_000n;
  const fraction = nano % 1_000_000_000n;
  const fracStr = fraction.toString().padStart(9, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
};

const shortAddress = (value?: string) => {
  if (!value) return "JETTON";
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

export const buildSwapSummary = (entries: ActionEntry[], trackedRawAddress: string): SwapSummary | null => {
  type AssetAggregate = {
    assetKey: string;
    asset: string;
    rawAmount: bigint;
    decimals?: number;
  };

  const incoming = new Map<string, AssetAggregate>();
  const outgoing = new Map<string, AssetAggregate>();
  let hasJetton = false;

  const upsert = (map: Map<string, AssetAggregate>, entry: AssetAggregate) => {
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

  const pickLargest = (values: IterableIterator<AssetAggregate>) => {
    let best: AssetAggregate | undefined;
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

  const formatAmount = (entry: AssetAggregate) => {
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
