import "dotenv/config";
import pino from "pino";
import { Telegraf } from "telegraf";
import { prisma } from "./prisma";
import {
  DEFAULT_LANGUAGE,
  Language,
  formatAmount,
  formatUsd,
  shortAddress,
  addressLink,
  txLink,
  t
} from "@tracker/common";
import { Prisma } from "@prisma/client";

const logger = pino({ name: "watcher" });

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required");
}

const TONAPI_BASE = process.env.TONAPI_BASE ?? "https://tonapi.io/v2";
const TONAPI_KEY = process.env.TONAPI_KEY;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 12000);

const bot = new Telegraf(BOT_TOKEN);

let lastEmptyWalletLogAt = 0;

type TonApiEvent = {
  event_id: string;
  lt?: string;
  timestamp?: number;
  actions: TonApiAction[];
};

type TonApiAction = {
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
  jetton_transfer?: {
    amount?: string;
    jetton?: { symbol?: string; decimals?: number };
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

type NormalizedAction = {
  actionId: string;
  type: "TON" | "JETTON" | "NFT";
  direction: "IN" | "OUT";
  amount?: string;
  asset: string;
  usd?: number | null;
  counterparty?: { address?: string; name?: string };
  nftName?: string;
  nftCollection?: string;
  note?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toTon = (amount?: string) => {
  if (!amount) return "0";
  const nano = BigInt(amount);
  const whole = nano / 1_000_000_000n;
  const fraction = nano % 1_000_000_000n;
  const fracStr = fraction.toString().padStart(9, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
};

const toJetton = (amount?: string, decimals = 0) => {
  if (!amount) return "0";
  const base = BigInt(amount);
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = base / divisor;
  const fraction = base % divisor;
  const fracStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
};

const safeBigInt = (value?: string) => {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

const hasMaestroNote = (action: TonApiAction) => {
  const preview = `${action.simple_preview?.name ?? ""} ${action.simple_preview?.description ?? ""}`.toLowerCase();
  return preview.includes("maestro");
};

const shouldSkipAction = (action: TonApiAction) => {
  if (action.type !== "TonTransfer") return false;
  if (action.ton_transfer?.is_internal) return true;
  const comment = (action.ton_transfer?.comment ?? "").toLowerCase();
  if (comment.includes("obvjazka") || comment.includes("wrap") || comment.includes("wrapping")) {
    return true;
  }
  return false;
};

const normalizeActions = (actions: TonApiAction[], trackedAddress: string): NormalizedAction[] => {
  return actions
    .filter((action) => action.status !== "failed")
    .filter((action) => !shouldSkipAction(action))
    .flatMap<NormalizedAction>((action): NormalizedAction[] => {
      const note = hasMaestroNote(action) ? "maestro" : undefined;
      if (action.type === "TonTransfer" && action.ton_transfer) {
        const sender = action.ton_transfer.sender?.address;
        const recipient = action.ton_transfer.recipient?.address;
        if (sender !== trackedAddress && recipient !== trackedAddress) return [];
        const direction = sender === trackedAddress ? "OUT" : "IN";
        const counterparty = sender === trackedAddress ? action.ton_transfer.recipient : action.ton_transfer.sender;
        return [
          {
            actionId: action.action_id ?? `${action.type}-${sender}-${recipient}-${action.ton_transfer.amount ?? "0"}`,
            type: "TON",
            direction,
            amount: toTon(action.ton_transfer.amount),
            asset: "TON",
            usd: action.ton_transfer.amount_usd ?? action.simple_preview?.value_usd,
            counterparty,
            note
          }
        ];
      }
      if (action.type === "JettonTransfer" && action.jetton_transfer) {
        const sender = action.jetton_transfer.sender?.address;
        const recipient = action.jetton_transfer.recipient?.address;
        if (sender !== trackedAddress && recipient !== trackedAddress) return [];
        const direction = sender === trackedAddress ? "OUT" : "IN";
        const counterparty = sender === trackedAddress ? action.jetton_transfer.recipient : action.jetton_transfer.sender;
        const decimals = action.jetton_transfer.jetton?.decimals ?? 0;
        return [
          {
            actionId: action.action_id ?? `${action.type}-${sender}-${recipient}-${action.jetton_transfer.amount ?? "0"}`,
            type: "JETTON",
            direction,
            amount: toJetton(action.jetton_transfer.amount, decimals),
            asset: action.jetton_transfer.jetton?.symbol ?? "JETTON",
            usd: action.jetton_transfer.amount_usd ?? action.simple_preview?.value_usd,
            counterparty,
            note
          }
        ];
      }
      if (action.type === "NftTransfer" && action.nft_transfer) {
        const sender = action.nft_transfer.sender?.address;
        const recipient = action.nft_transfer.recipient?.address;
        if (sender !== trackedAddress && recipient !== trackedAddress) return [];
        const direction = sender === trackedAddress ? "OUT" : "IN";
        const counterparty = sender === trackedAddress ? action.nft_transfer.recipient : action.nft_transfer.sender;
        return [
          {
            actionId: action.action_id ?? `${action.type}-${sender}-${recipient}-${action.nft_transfer.nft?.name ?? "NFT"}`,
            type: "NFT",
            direction,
            asset: "NFT",
            counterparty,
            nftName: action.nft_transfer.nft?.name ?? "NFT",
            nftCollection: action.nft_transfer.nft?.collection?.name ?? "Collection",
            note
          }
        ];
      }
      return [];
    });
};

const formatCounterparty = (value: { address?: string; name?: string } | undefined, lang: Language) => {
  if (!value) return t(lang, "unknown");
  const label = value.name ?? value.address ?? t(lang, "unknown");
  if (value.address) {
    const display = value.name ?? shortAddress(value.address);
    return `<a href=\"${addressLink(value.address)}\">${display}</a>`;
  }
  return label;
};

const formatActionLine = (action: NormalizedAction, lang: Language) => {
  if (action.type === "NFT") {
    return t(lang, "nftLine", {
      direction: action.direction === "IN" ? t(lang, "directionIn") : t(lang, "directionOut"),
      count: 1,
      name: action.nftName ?? "NFT",
      collection: action.nftCollection ?? "Collection"
    });
  }
  const directionLabel = action.direction === "IN" ? t(lang, "received") : t(lang, "sent");
  const usd = formatUsd(action.usd ?? null);
  const counterpartyLabel = formatCounterparty(action.counterparty, lang);
  const prefix = action.direction === "IN" ? t(lang, "from") : t(lang, "to");
  const amount = action.amount ? formatAmount(action.amount) : "0";
  return `${directionLabel}: ${amount} ${action.asset} ${usd ? `(${usd})` : ""} ${prefix}: ${counterpartyLabel}`.trim();
};

const formatMessage = (walletName: string, txHash: string, actions: NormalizedAction[], lang: Language) => {
  const assetLabel = actions.every((action) => action.type === actions[0].type)
    ? actions[0].asset
    : "TON";
  const title = `${walletName} · ${assetLabel}`;
  const lines = actions.map((action) => formatActionLine(action, lang));
  if (actions.some((action) => action.note === "maestro")) {
    lines.push(t(lang, "maestroNote"));
  }
  lines.push(`<a href=\"${txLink(txHash)}\">${t(lang, "txHash")}<\/a>`);
  return `${title}\n${lines.join("\n")}`;
};

async function fetchEvents(address: string, lastLt?: string): Promise<TonApiEvent[]> {
  const url = new URL(`${TONAPI_BASE}/accounts/${address}/events`);
  url.searchParams.set("limit", "20");
  if (lastLt) {
    url.searchParams.set("start_lt", lastLt);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (TONAPI_KEY) {
    headers.Authorization = `Bearer ${TONAPI_KEY}`;
  }
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const bodyText = await response.text();
    logger.warn(
      { status: response.status, address, body: bodyText.slice(0, 200) },
      "tonapi request failed"
    );
    throw new Error(`TonAPI error ${response.status}`);
  }
  const data = (await response.json()) as { events?: TonApiEvent[] };
  return data.events ?? [];
}

async function processWallet(wallet: { id: string; address: string; name: string; lastEventLt: string | null; userId: string }) {
  const user = await prisma.user.findUnique({ where: { id: wallet.userId } });
  if (!user) return;
  const lang = (user.language as Language) ?? DEFAULT_LANGUAGE;

  let events: TonApiEvent[] = [];
  try {
    events = await fetchEvents(wallet.address, wallet.lastEventLt ?? undefined);
  } catch (error) {
    logger.warn({ error, wallet: wallet.id }, "failed to fetch events");
    return;
  }

  const actionsCount = events.reduce((sum, event) => sum + (event.actions?.length ?? 0), 0);
  logger.info(
    { walletId: wallet.id, address: wallet.address, events: events.length, actions: actionsCount },
    "tonapi events fetched"
  );

  if (events.length === 0) return;

  const sorted = events.sort((a, b) => Number(safeBigInt(a.lt) - safeBigInt(b.lt)));
  let maxLt = wallet.lastEventLt ? safeBigInt(wallet.lastEventLt) : 0n;

  for (const event of sorted) {
    const eventLt = safeBigInt(event.lt);
    if (eventLt <= maxLt) continue;
    const normalized = normalizeActions(event.actions, wallet.address);
    if (normalized.length === 0) {
      maxLt = eventLt > maxLt ? eventLt : maxLt;
      continue;
    }
    const createdActions: NormalizedAction[] = [];
    for (const action of normalized) {
      try {
        await prisma.walletEvent.create({
          data: {
            walletId: wallet.id,
            txHash: event.event_id,
            actionId: action.actionId,
            type: action.type,
            direction: action.direction,
            asset: action.asset,
            amount: action.amount ?? null,
            counterparty: action.counterparty?.address ?? action.counterparty?.name ?? null,
            metadata: action
          }
        });
        createdActions.push(action);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          continue;
        }
        throw error;
      }
    }

    if (createdActions.length > 0) {
      const message = formatMessage(wallet.name, event.event_id, createdActions, lang);
      try {
        await bot.telegram.sendMessage(Number(user.telegramId), message, { parse_mode: "HTML" });
        logger.info(
          { chatId: Number(user.telegramId), walletId: wallet.id, txHash: event.event_id },
          "telegram notification sent"
        );
      } catch (error) {
        logger.error(
          { error, chatId: Number(user.telegramId), walletId: wallet.id, txHash: event.event_id },
          "failed to send telegram notification"
        );
      }
    }

    maxLt = eventLt > maxLt ? eventLt : maxLt;
  }

  if (maxLt > safeBigInt(wallet.lastEventLt ?? "0")) {
    await prisma.wallet.update({ where: { id: wallet.id }, data: { lastEventLt: maxLt.toString() } });
  }
}

async function poll() {
  const wallets = await prisma.wallet.findMany();
  const sample = wallets.slice(0, 2).map((wallet) => ({ id: wallet.id, address: wallet.address }));
  if (wallets.length === 0) {
    const now = Date.now();
    if (now - lastEmptyWalletLogAt > 60_000) {
      logger.info("0 wallets tracked");
      lastEmptyWalletLogAt = now;
    }
    return;
  }
  logger.info({ count: wallets.length, sample }, "poll tick");
  for (const wallet of wallets) {
    await processWallet(wallet);
    await sleep(200);
  }
}

async function start() {
  logger.info("watcher started");
  while (true) {
    const startAt = Date.now();
    try {
      await poll();
    } catch (error) {
      logger.error({ error }, "poll error");
    }
    const elapsed = Date.now() - startAt;
    const wait = Math.max(POLL_INTERVAL_MS - elapsed, 1000);
    await sleep(wait);
  }
}

start().catch((error) => {
  logger.error({ error }, "watcher failed");
  process.exit(1);
});
