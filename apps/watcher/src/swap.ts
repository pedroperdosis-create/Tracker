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

export const buildSwapSummary = (entries: ActionEntry[], trackedRawAddress: string): SwapSummary | null => {
  const jettonEntries = entries.filter(({ action }) => action.type === "JettonTransfer" && getJettonTransfer(action));
  const tonEntries = entries.filter(({ action }) => action.type === "TonTransfer" && getTonTransfer(action));

  if (jettonEntries.length === 0) {
    return null;
  }

  let tokenBought: SwapToken | undefined;
  let tokenSold: SwapToken | undefined;

  let netUsdJetton: { amount: bigint; symbol?: string } | null = null;

  for (const { action } of jettonEntries) {
    if (action.status && action.status !== "ok") continue;
    const transfer = getJettonTransfer(action);
    if (!transfer) continue;
    const sender = transfer.sender?.address;
    const recipient = transfer.recipient?.address;
    const direction = getDirection(trackedRawAddress, sender, recipient);
    if (!direction) continue;
    const decimals = transfer.jetton?.decimals;
    const rawAmount = transfer.amount ? String(transfer.amount) : "0";
    const amount = typeof decimals === "number" ? toJetton(rawAmount, decimals) : rawAmount;
    const asset = transfer.jetton?.symbol ?? transfer.jetton?.address ?? "JETTON";
    if (isUsdJetton(transfer.jetton?.symbol)) {
      const delta = BigInt(rawAmount);
      if (!netUsdJetton) {
        netUsdJetton = { amount: 0n, symbol: transfer.jetton?.symbol };
      }
      if (recipient === trackedRawAddress) {
        netUsdJetton.amount += delta;
      } else if (sender === trackedRawAddress) {
        netUsdJetton.amount -= delta;
      }
    }
    if (direction === "IN" && !tokenBought) {
      tokenBought = { asset, amount };
    }
    if (direction === "OUT" && !tokenSold) {
      tokenSold = { asset, amount };
    }
  }

  if (!tokenBought && !tokenSold) {
    return null;
  }

  let quote: SwapToken | undefined;

  if (tonEntries.length > 0) {
    let netTon = 0n;
    for (const { action } of tonEntries) {
      const transfer = getTonTransfer(action);
      if (!transfer) continue;
      const sender = transfer.sender?.address;
      const recipient = transfer.recipient?.address;
      if (sender === trackedRawAddress) {
        netTon -= BigInt(transfer.amount ?? "0");
      } else if (recipient === trackedRawAddress) {
        netTon += BigInt(transfer.amount ?? "0");
      }
    }
    if (netTon !== 0n) {
      quote = { asset: "TON", amount: toTon(netTon < 0n ? (-netTon).toString() : netTon.toString()) };
    }
  }

  if (!quote && netUsdJetton && netUsdJetton.amount !== 0n) {
    const decimals = jettonEntries
      .map(({ action }) => getJettonTransfer(action)?.jetton?.decimals)
      .find((value) => typeof value === "number");
    const rawAmount = netUsdJetton.amount < 0n ? (-netUsdJetton.amount).toString() : netUsdJetton.amount.toString();
    const amount = typeof decimals === "number" ? toJetton(rawAmount, decimals) : rawAmount;
    quote = { asset: netUsdJetton.symbol ?? "USD₮", amount };
  }

  const hasBothJettonSides = tokenBought && tokenSold && tokenBought.asset !== tokenSold.asset;
  const hasJettonAndQuote = (tokenBought || tokenSold) && quote;
  const isSameAssetQuote =
    quote && (tokenBought?.asset === quote.asset || tokenSold?.asset === quote.asset);

  if (!hasBothJettonSides && (!hasJettonAndQuote || isSameAssetQuote)) {
    return null;
  }

  return { tokenBought, tokenSold, quote };
};
