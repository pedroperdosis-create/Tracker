export const getJettonTransfer = (action) =>
  action.jetton_transfer ?? action.jettonTransfer ?? action.JettonTransfer;

export const getTonTransfer = (action) =>
  action.ton_transfer ?? action.tonTransfer ?? action.TonTransfer;

export const isUsdJetton = (symbol) => (symbol ?? "").toLowerCase().includes("usd");

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

export const buildSwapSummary = (entries, trackedRawAddress) => {
  const jettonEntries = entries.filter(({ action }) => action.type === "JettonTransfer" && getJettonTransfer(action));
  const tonEntries = entries.filter(({ action }) => action.type === "TonTransfer" && getTonTransfer(action));

  if (jettonEntries.length === 0) {
    return null;
  }

  let tokenBought;
  let tokenSold;
  let netUsdJetton = null;

  for (const { action } of jettonEntries) {
    if (action.status && action.status !== "ok") continue;
    const transfer = getJettonTransfer(action);
    if (!transfer) continue;
    const sender = transfer.sender?.address;
    const recipient = transfer.recipient?.address;
    if (sender !== trackedRawAddress && recipient !== trackedRawAddress) continue;
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
    if (recipient === trackedRawAddress && !tokenBought) {
      tokenBought = { asset, amount };
    }
    if (sender === trackedRawAddress && !tokenSold) {
      tokenSold = { asset, amount };
    }
  }

  if (!tokenBought && !tokenSold) {
    return null;
  }

  let quote;
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
  const isSameAssetQuote = quote && (tokenBought?.asset === quote.asset || tokenSold?.asset === quote.asset);

  if (!hasBothJettonSides && (!hasJettonAndQuote || isSameAssetQuote)) {
    return null;
  }

  return { tokenBought, tokenSold, quote };
};
