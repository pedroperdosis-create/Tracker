import "dotenv/config";
import express, { type Request, type Response } from "express";
import pino from "pino";
import { Telegraf } from "telegraf";
import { Address } from "@ton/core";
import WebSocket, { type RawData } from "ws";
import {
  ActionEntry,
  SwapSummary,
  TonApiAction,
  buildSwapSummary,
  getDirection,
  getJettonTransfer,
  getTonTransfer
} from "./swap";
import { createEmptyProcessResult } from "./process-result";
import type { ProcessWalletResult } from "./process-result";
import {
  TonApiError,
  TonApiLimiter,
  buildTonTransferActionsFromTransaction,
  fetchTonApiTransaction
} from "./tonapi";
import { prisma } from "./prisma";
import { createDebouncedInFlightQueue } from "./ws-queue";
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
import { type Wallet as PrismaWallet } from "@prisma/client";
import { extractWebhookHint, type WebhookPayload } from "./webhook-payload";
import { diffAccountSubscriptions, splitIntoBatches } from "./webhook-sync";

const logger = pino({ name: "watcher" });

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is required");
}

const TONAPI_BASE = process.env.TONAPI_BASE ?? "https://tonapi.io/v2";
const TONAPI_KEY =
  process.env.TONAPI_KEY ?? "AES6MBCFSX4OA5YAAAAEOKA4IDVVAWPYWRYGB2F565FVTBEZGTVO5JF4FERIZWPSEYGO23Y";
const FAST_MODE = process.env.FAST_MODE === "1";
const BASE_POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? (FAST_MODE ? 2000 : 5000));
const FAST_POLL_INTERVAL_MS = Number(process.env.FAST_POLL_INTERVAL_MS ?? (FAST_MODE ? 1500 : 3000));
const MAX_BACKOFF_MS = Number(process.env.MAX_POLL_BACKOFF_MS ?? 60000);
const MAX_PARALLEL_WALLETS = Number(process.env.MAX_PARALLEL_WALLETS ?? 3);
const TONAPI_RPS = Number(process.env.TONAPI_RPS ?? 2);
const TONAPI_BURST = Number(process.env.TONAPI_BURST ?? 2);
const TONAPI_CONCURRENCY = Number(process.env.TONAPI_CONCURRENCY ?? 1);

const tonapiLimiter = new TonApiLimiter({
  rps: TONAPI_RPS,
  burst: TONAPI_BURST,
  concurrency: TONAPI_CONCURRENCY
});

const WS_MODE = process.env.WS_MODE === "1";
const TONCENTER_WS_URL = process.env.TONCENTER_WS_URL;
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY;
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT ?? 8080);
const TONAPI_WEBHOOK_SECRET = process.env.TONAPI_WEBHOOK_SECRET;
const WEBHOOK_PUBLIC_URL = process.env.WEBHOOK_PUBLIC_URL;
const WEBHOOK_SYNC_INTERVAL_MS = Number(process.env.WEBHOOK_SYNC_INTERVAL_MS ?? 30000);
const WEBHOOK_SYNC_BATCH = Number(process.env.WEBHOOK_SYNC_BATCH ?? 50);
const WEBHOOK_MODE = Boolean(WEBHOOK_PUBLIC_URL && TONAPI_KEY);
const FAST_POLLING_ENABLED = FAST_MODE && !WEBHOOK_MODE;

const walletSchedule = new Map<string, { nextPollAt: number; backoffMs: number }>();
let lastScheduleLogAt = 0;

const bot = new Telegraf(BOT_TOKEN);

let lastEmptyWalletLogAt = 0;

type TonApiEvent = {
  event_id: string;
  lt?: string;
  timestamp?: number;
  actions: TonApiAction[];
  transaction?: {
    lt?: string;
  };
  base_transactions?: string[];
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
  raw?: TonApiAction;
};

type NotifierUser = {
  telegramId: string;
};

type ProcessWalletInput = Pick<PrismaWallet, "id" | "address" | "name" | "lastEventLt" | "userId">;
type WsWallet = ProcessWalletInput;

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

const normalizeError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
const isUniqueViolation = (error: unknown) => {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "P2002";
};

const extractEventLt = (event: TonApiEvent): string | null => {
  const lt = event.lt ?? event.transaction?.lt;
  if (!lt) return null;
  try {
    BigInt(lt);
    return lt;
  } catch {
    return null;
  }
};

const buildCursor = (lt: string, actionIndex: number) => BigInt(lt) * 1000n + BigInt(actionIndex);

const normalizeStoredCursor = (value?: string | null): bigint | null => {
  if (!value) return null;
  try {
    const cursor = BigInt(value);
    return cursor < 1_000_000_000_000_000n ? cursor * 1000n : cursor;
  } catch {
    return null;
  }
};

const hasMaestroNote = (action: TonApiAction) => {
  const preview = `${action.simple_preview?.name ?? ""} ${action.simple_preview?.description ?? ""}`.toLowerCase();
  return preview.includes("maestro");
};

const tonTransferRegressionGuard = () => "TON transfer normalization guard: do not modify without regression check.";

const shouldSkipAction = (action: TonApiAction) => {
  if (action.type !== "TonTransfer") return false;
  const transfer = action.ton_transfer ?? action.tonTransfer ?? action.TonTransfer;
  if (transfer?.is_internal) return true;
  const comment = (transfer?.comment ?? "").toLowerCase();
  if (comment.includes("obvjazka") || comment.includes("wrap") || comment.includes("wrapping")) {
    return true;
  }
  return false;
};

const normalizeActions = (
  entries: ActionEntry[],
  trackedAddress: string,
  trackedRawAddress: string,
  eventId: string
): NormalizedAction[] => {
  return entries
    .filter(({ action }) => action.status !== "failed")
    .filter(({ action }) => !shouldSkipAction(action))
    .flatMap<NormalizedAction>(({ action, index }): NormalizedAction[] => {
      const note = hasMaestroNote(action) ? "maestro" : undefined;
      const tonTransfer = action.ton_transfer ?? action.tonTransfer ?? action.TonTransfer;
      // TON transfer normalization is considered stable; do not modify without regression verification.
      if (action.type === "TonTransfer" && tonTransfer) {
        const sender = tonTransfer.sender?.address;
        const recipient = tonTransfer.recipient?.address;
        const direction = getDirection(trackedRawAddress, sender, recipient);
        if (!direction) return [];
        const counterparty = sender === trackedRawAddress ? tonTransfer.recipient : tonTransfer.sender;
        logger.debug(
          {
            walletAddress: trackedAddress,
            walletRaw: trackedRawAddress,
            sender,
            recipient,
            direction,
            guard: tonTransferRegressionGuard()
          },
          "ton transfer match"
        );
        return [
          {
            actionId: `${eventId}:${index}`,
            type: "TON",
            direction,
            amount: toTon(tonTransfer.amount),
            asset: "TON",
            usd: tonTransfer.amount_usd ?? action.simple_preview?.value_usd,
            counterparty,
            note,
            raw: action
          }
        ];
      }
      const jettonTransfer = getJettonTransfer(action);
      if (action.type === "JettonTransfer" && jettonTransfer) {
        if (action.status && action.status !== "ok") return [];
        const sender = jettonTransfer.sender?.address;
        const recipient = jettonTransfer.recipient?.address;
        const direction = getDirection(trackedRawAddress, sender, recipient);
        if (!direction) return [];
        const counterparty = sender === trackedRawAddress ? jettonTransfer.recipient : jettonTransfer.sender;
        const decimals = jettonTransfer.jetton?.decimals;
        const rawAmount = jettonTransfer.amount ? String(jettonTransfer.amount) : "0";
        const amount =
          typeof decimals === "number" ? toJetton(rawAmount, decimals) : rawAmount;
        const asset = jettonTransfer.jetton?.symbol ?? jettonTransfer.jetton?.address ?? "JETTON";
        return [
          {
            actionId: `${eventId}:${index}`,
            type: "JETTON",
            direction,
            amount,
            asset,
            usd: jettonTransfer.amount_usd ?? action.simple_preview?.value_usd,
            counterparty,
            note,
            raw: action
          }
        ];
      }
      if (action.type === "NftTransfer" && action.nft_transfer) {
        const sender = action.nft_transfer.sender?.address;
        const recipient = action.nft_transfer.recipient?.address;
        if (sender !== trackedRawAddress && recipient !== trackedRawAddress) return [];
        const direction = sender === trackedRawAddress ? "OUT" : "IN";
        const counterparty = sender === trackedRawAddress ? action.nft_transfer.recipient : action.nft_transfer.sender;
        return [
          {
            actionId: `${eventId}:${index}`,
            type: "NFT",
            direction,
            asset: "NFT",
            counterparty,
            nftName: action.nft_transfer.nft?.name ?? "NFT",
            nftCollection: action.nft_transfer.nft?.collection?.name ?? "Collection",
            note,
            raw: action
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

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const formatSwapMessage = (
  walletName: string,
  walletAddress: string,
  txHash: string,
  summary: SwapSummary,
  lang: Language
) => {
  const title = `<a href=\"${addressLink(walletAddress)}\">${escapeHtml(walletName)}</a> · SWAP`;
  const lines: string[] = [];
  if (summary.tokenBought) {
    lines.push(
      lang === "ru"
        ? `Куплено: ${summary.tokenBought.amount} ${summary.tokenBought.asset}`
        : `Bought: ${summary.tokenBought.amount} ${summary.tokenBought.asset}`
    );
  }
  if (summary.tokenSold) {
    lines.push(
      lang === "ru"
        ? `Продано: ${summary.tokenSold.amount} ${summary.tokenSold.asset}`
        : `Sold: ${summary.tokenSold.amount} ${summary.tokenSold.asset}`
    );
  }
  if (summary.quote) {
    lines.push(
      lang === "ru"
        ? `${summary.tokenBought ? "За" : "Получено"}: ${summary.quote.amount} ${summary.quote.asset}`
        : `${summary.tokenBought ? "For" : "Received"}: ${summary.quote.amount} ${summary.quote.asset}`
    );
  }
  lines.push(`<a href=\"${txLink(txHash)}\">${t(lang, "txHash")}<\/a>`);
  return `${title}\n${lines.join("\n")}`;
};

const formatMessage = (walletName: string, walletAddress: string, txHash: string, actions: NormalizedAction[], lang: Language) => {
  const assetLabel = actions.every((action) => action.type === actions[0].type)
    ? actions[0].asset
    : "TON";
  const title = `<a href=\"${addressLink(walletAddress)}\">${escapeHtml(walletName)}</a> · ${assetLabel}`;
  const lines = actions.map((action) => formatActionLine(action, lang));
  if (actions.some((action) => action.note === "maestro")) {
    lines.push(t(lang, "maestroNote"));
  }
  lines.push(`<a href=\"${txLink(txHash)}\">${t(lang, "txHash")}<\/a>`);
  return `${title}\n${lines.join("\n")}`;
};

async function fetchEvents(address: string, lastLt?: string): Promise<TonApiEvent[]> {
  const url = new URL(`${TONAPI_BASE}/accounts/${address}/events`);
  url.searchParams.set("limit", "10");
  if (lastLt) {
    url.searchParams.set("start_lt", lastLt);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (TONAPI_KEY) {
    headers.Authorization = `Bearer ${TONAPI_KEY}`;
  }
  const response = await tonapiLimiter.schedule(() => fetch(url, { headers }));
  if (!response.ok) {
    const bodyText = await response.text();
    tonapiLimiter.markResponse(response.status);
    logger.warn(
      { status: response.status, address, body: bodyText.slice(0, 200) },
      "tonapi request failed"
    );
    throw new TonApiError(response.status, `TonAPI error ${response.status}`);
  }
  tonapiLimiter.markResponse(response.status);
  const data = (await response.json()) as { events?: TonApiEvent[] };
  return data.events ?? [];
}

const processEventsForWallet = async (
  wallet: ProcessWalletInput,
  events: TonApiEvent[],
  user: NotifierUser,
  lang: Language,
  source: "polling" | "webhook" | "ws"
): Promise<ProcessWalletResult> => {
  const walletRaw = Address.parse(wallet.address).toRawString();
  const actionsCount = events.reduce((sum, event) => sum + (event.actions?.length ?? 0), 0);
  const sampleEvent = events[0];
  const sampleLt = sampleEvent ? extractEventLt(sampleEvent) : null;
  const maxFetchedCursor = events.reduce((max, event) => {
    const lt = extractEventLt(event);
    if (!lt) return max;
    const cursor = buildCursor(lt, Math.max(0, (event.actions?.length ?? 1) - 1));
    return cursor > max ? cursor : max;
  }, 0n);
  logger.info(
    {
      walletId: wallet.id,
      address: wallet.address,
      events: events.length,
      actions: actionsCount,
      sample: sampleEvent ? { txHash: sampleEvent.event_id, lt: sampleLt } : null,
      maxFetchedCursor: maxFetchedCursor ? maxFetchedCursor.toString() : null,
      source
    },
    "tonapi events fetched"
  );

  if (events.length === 0) return createEmptyProcessResult();

  const cursorBefore = normalizeStoredCursor(wallet.lastEventLt);
  const sorted = events.sort((a, b) => {
    const aLt = extractEventLt(a);
    const bLt = extractEventLt(b);
    if (!aLt || !bLt) return 0;
    return Number(BigInt(aLt) - BigInt(bLt));
  });
  let maxCursor = cursorBefore ?? 0n;
  let newCount = 0;
  let normalizedCountTotal = 0;
  let insertedCount = 0;
  let insertErrorsCount = 0;
  let notifiedCount = 0;

  for (const event of sorted) {
    const eventLtRaw = extractEventLt(event);
    if (!eventLtRaw) {
      logger.warn({ txHash: event.event_id }, "missing or invalid lt in event");
      continue;
    }
    const eventCursor = buildCursor(eventLtRaw, Math.max(0, event.actions.length - 1));
    if (cursorBefore !== null && eventCursor <= cursorBefore) {
      continue;
    }
    newCount += 1;
    const actionTypes = event.actions.map((action) => action.type);
    const tonTxHash = event.base_transactions?.[0] ?? event.event_id;
    const actionEntries = event.actions.map((action, index) => ({ action, index }));
    const swapSummary = buildSwapSummary(actionEntries, walletRaw);
    const hasJettonTransferForWallet = actionEntries.some(({ action }) => {
      if (action.type !== "JettonTransfer") return false;
      const transfer = getJettonTransfer(action);
      if (!transfer) return false;
      if (action.status && action.status !== "ok") return false;
      const sender = transfer.sender?.address;
      const recipient = transfer.recipient?.address;
      return sender === walletRaw || recipient === walletRaw;
    });
    const entriesForNormalization = hasJettonTransferForWallet
      ? actionEntries.filter(({ action }) => action.type === "JettonTransfer")
      : actionEntries;
    const normalized = normalizeActions(entriesForNormalization, wallet.address, walletRaw, event.event_id);
    normalizedCountTotal += normalized.length;
    logger.info(
      { txHash: event.event_id, lt: eventLtRaw, actionTypes, normalizedCount: normalized.length },
      "processing event"
    );
    if (normalized.length === 0) {
      logger.warn(
        { txHash: event.event_id, lt: eventLtRaw, actionTypes },
        "no normalized actions for event"
      );
      maxCursor = eventCursor > maxCursor ? eventCursor : maxCursor;
      continue;
    }
    const createdActions: NormalizedAction[] = [];
    for (const action of normalized) {
      const txHash = action.type === "JETTON" ? event.event_id : tonTxHash;
      try {
        await prisma.walletEvent.create({
          data: {
            walletId: wallet.id,
            txHash,
            actionId: action.actionId,
            type: action.type,
            direction: action.direction,
            asset: action.asset,
            amount: action.amount ?? null,
            counterparty: action.counterparty?.address ?? action.counterparty?.name ?? null,
            metadata: {
              action,
              event: { id: event.event_id, lt: eventLtRaw, txHash },
              jetton:
                action.type === "JETTON"
                  ? {
                      symbol: action.asset,
                      decimals:
                        getJettonTransfer((action.raw ?? {}) as TonApiAction)?.jetton?.decimals ??
                        null,
                      rawAmount:
                        getJettonTransfer((action.raw ?? {}) as TonApiAction)?.amount ?? null,
                      address:
                        getJettonTransfer((action.raw ?? {}) as TonApiAction)?.jetton?.address ??
                        null,
                      originalAction: action.raw ?? null
                    }
                  : null
            }
          }
        });
        createdActions.push(action);
        insertedCount += 1;
        if (action.type === "JETTON") {
          const transfer = getJettonTransfer((action.raw ?? {}) as TonApiAction);
          logger.info(
            {
              walletId: wallet.id,
              txHash,
              symbol: action.asset,
              direction: action.direction,
              humanAmount: action.amount ?? "0",
              rawAmount: transfer?.amount ?? null,
              decimals: transfer?.jetton?.decimals ?? null
            },
            "Jetton processed"
          );
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          continue;
        }
        const err = normalizeError(error);
        insertErrorsCount += 1;
        logger.error(
          {
            error: err,
            txHash: event.event_id,
            actionId: action.actionId,
            type: action.type,
            stack: err.stack?.split("\n").slice(0, 3).join("\n")
          },
          "failed to insert wallet event"
        );
        throw error;
      }
    }

    if (createdActions.length > 0) {
      const messageTxHash = createdActions.every((action) => action.type === "JETTON") ? event.event_id : tonTxHash;
      const message = swapSummary
        ? formatSwapMessage(wallet.name, wallet.address, messageTxHash, swapSummary, lang)
        : formatMessage(wallet.name, wallet.address, messageTxHash, createdActions, lang);
      try {
        const chatId = user.telegramId.toString();
        await bot.telegram.sendMessage(chatId, message, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true }
        });
        logger.info({ chatId, walletId: wallet.id, txHash: messageTxHash }, "notification sent");
        notifiedCount += 1;
      } catch (error) {
        logger.warn({ error, chatId: user.telegramId.toString(), walletId: wallet.id, txHash: messageTxHash }, "notification failed");
      }
    }

    maxCursor = eventCursor > maxCursor ? eventCursor : maxCursor;
  }

  logger.info(
    {
      walletId: wallet.id,
      cursorBefore: cursorBefore?.toString() ?? null,
      maxFetchedCursor: maxFetchedCursor ? maxFetchedCursor.toString() : null,
      newCount,
      normalizedCountTotal,
      insertedCount,
      insertErrorsCount,
      notifiedCount,
      cursorAfter: maxCursor.toString()
    },
    "wallet processing summary"
  );

  if (cursorBefore === null ? newCount > 0 : normalizedCountTotal > 0 && insertedCount > 0) {
    await prisma.wallet.update({ where: { id: wallet.id }, data: { lastEventLt: maxCursor.toString() } });
  }
  return { newCount, notifiedCount };
};

async function processWallet(wallet: ProcessWalletInput): Promise<ProcessWalletResult> {
  const user = await prisma.user.findUnique({ where: { id: wallet.userId } });
  if (!user) return { newCount: 0, notifiedCount: 0 };
  const lang = (user.language as Language) ?? DEFAULT_LANGUAGE;
  const walletRaw = Address.parse(wallet.address).toRawString();

  let events: TonApiEvent[] = [];
  try {
    events = await fetchEvents(wallet.address);
  } catch (error) {
    logger.warn({ error, wallet: wallet.id }, "failed to fetch events");
    if (error instanceof TonApiError) {
      return { ...createEmptyProcessResult(), errorStatus: error.status };
    }
    return createEmptyProcessResult();
  }

  const actionsCount = events.reduce((sum, event) => sum + (event.actions?.length ?? 0), 0);
  const sampleEvent = events[0];
  const sampleLt = sampleEvent ? extractEventLt(sampleEvent) : null;
  const maxFetchedCursor = events.reduce((max, event) => {
    const lt = extractEventLt(event);
    if (!lt) return max;
    const cursor = buildCursor(lt, Math.max(0, (event.actions?.length ?? 1) - 1));
    return cursor > max ? cursor : max;
  }, 0n);
  logger.info(
    {
      walletId: wallet.id,
      address: wallet.address,
      events: events.length,
      actions: actionsCount,
      sample: sampleEvent ? { txHash: sampleEvent.event_id, lt: sampleLt } : null,
      maxFetchedCursor: maxFetchedCursor ? maxFetchedCursor.toString() : null
    },
    "tonapi events fetched"
  );

  if (events.length === 0) return createEmptyProcessResult();

  const cursorBefore = normalizeStoredCursor(wallet.lastEventLt);
  const sorted = events.sort((a, b) => {
    const aLt = extractEventLt(a);
    const bLt = extractEventLt(b);
    if (!aLt || !bLt) return 0;
    return Number(BigInt(aLt) - BigInt(bLt));
  });
  let maxCursor = cursorBefore ?? 0n;
  let newCount = 0;
  let normalizedCountTotal = 0;
  let insertedCount = 0;
  let insertErrorsCount = 0;
  let notifiedCount = 0;

  for (const event of sorted) {
    const eventLtRaw = extractEventLt(event);
    if (!eventLtRaw) {
      logger.warn({ txHash: event.event_id }, "missing or invalid lt in event");
      continue;
    }
    const eventCursor = buildCursor(eventLtRaw, Math.max(0, event.actions.length - 1));
    if (cursorBefore !== null && eventCursor <= cursorBefore) {
      continue;
    }
    newCount += 1;
    const actionTypes = event.actions.map((action) => action.type);
    const tonTxHash = event.base_transactions?.[0] ?? event.event_id;
    const actionEntries = event.actions.map((action, index) => ({ action, index }));
    const swapSummary = buildSwapSummary(actionEntries, walletRaw);
    const hasJettonTransferForWallet = actionEntries.some(({ action }) => {
      if (action.type !== "JettonTransfer") return false;
      const transfer = getJettonTransfer(action);
      if (!transfer) return false;
      if (action.status && action.status !== "ok") return false;
      const sender = transfer.sender?.address;
      const recipient = transfer.recipient?.address;
      return sender === walletRaw || recipient === walletRaw;
    });
    const entriesForNormalization = hasJettonTransferForWallet
      ? actionEntries.filter(({ action }) => action.type === "JettonTransfer")
      : actionEntries;
    const normalized = normalizeActions(entriesForNormalization, wallet.address, walletRaw, event.event_id);
    normalizedCountTotal += normalized.length;
    logger.info(
      { txHash: event.event_id, lt: eventLtRaw, actionTypes, normalizedCount: normalized.length },
      "processing event"
    );
    if (normalized.length === 0) {
      logger.warn(
        { txHash: event.event_id, lt: eventLtRaw, actionTypes },
        "no normalized actions for event"
      );
      maxCursor = eventCursor > maxCursor ? eventCursor : maxCursor;
      continue;
    }
    const createdActions: NormalizedAction[] = [];
    for (const action of normalized) {
      const txHash = action.type === "JETTON" ? event.event_id : tonTxHash;
      try {
        await prisma.walletEvent.create({
          data: {
            walletId: wallet.id,
            txHash,
            actionId: action.actionId,
            type: action.type,
            direction: action.direction,
            asset: action.asset,
            amount: action.amount ?? null,
            counterparty: action.counterparty?.address ?? action.counterparty?.name ?? null,
            metadata: {
              action,
              event: { id: event.event_id, lt: eventLtRaw, txHash },
              jetton:
                action.type === "JETTON"
                  ? {
                      symbol: action.asset,
                      decimals:
                        getJettonTransfer((action.raw ?? {}) as TonApiAction)?.jetton?.decimals ??
                        null,
                      rawAmount:
                        getJettonTransfer((action.raw ?? {}) as TonApiAction)?.amount ?? null,
                      address:
                        getJettonTransfer((action.raw ?? {}) as TonApiAction)?.jetton?.address ??
                        null,
                      originalAction: action.raw ?? null
                    }
                  : null
            }
          }
        });
        createdActions.push(action);
        insertedCount += 1;
        if (action.type === "JETTON") {
          const transfer = getJettonTransfer((action.raw ?? {}) as TonApiAction);
          logger.info(
            {
              walletId: wallet.id,
              txHash,
              symbol: action.asset,
              direction: action.direction,
              humanAmount: action.amount ?? "0",
              rawAmount: transfer?.amount ?? null,
              decimals: transfer?.jetton?.decimals ?? null
            },
            "Jetton processed"
          );
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          continue;
        }
        const err = normalizeError(error);
        insertErrorsCount += 1;
        logger.error(
          {
            error: err,
            txHash: event.event_id,
            actionId: action.actionId,
            type: action.type,
            stack: err.stack?.split("\n").slice(0, 3).join("\n")
          },
          "failed to insert wallet event"
        );
        throw error;
      }
    }

    if (createdActions.length > 0) {
      const messageTxHash = createdActions.every((action) => action.type === "JETTON") ? event.event_id : tonTxHash;
      const message = swapSummary
        ? formatSwapMessage(wallet.name, wallet.address, messageTxHash, swapSummary, lang)
        : formatMessage(wallet.name, wallet.address, messageTxHash, createdActions, lang);
      try {
        const chatId = user.telegramId.toString();
        await bot.telegram.sendMessage(chatId, message, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true }
        });
        notifiedCount += 1;
        logger.info({ chatId, walletId: wallet.id, txHash: messageTxHash }, "telegram notification sent");
      } catch (error) {
        logger.error(
          { error, chatId: user.telegramId.toString(), walletId: wallet.id, txHash: messageTxHash },
          "failed to send telegram notification"
        );
      }
    }

    maxCursor = eventCursor > maxCursor ? eventCursor : maxCursor;
  }

  logger.info(
    {
      walletId: wallet.id,
      cursorBefore: cursorBefore?.toString() ?? null,
      maxFetchedCursor: maxFetchedCursor ? maxFetchedCursor.toString() : null,
      newCount,
      normalizedCountTotal,
      insertedCount,
      insertErrorsCount,
      notifiedCount,
      cursorAfter: maxCursor.toString()
    },
    "wallet processing summary"
  );

  if (cursorBefore === null ? newCount > 0 : normalizedCountTotal > 0 && insertedCount > 0) {
    await prisma.wallet.update({ where: { id: wallet.id }, data: { lastEventLt: maxCursor.toString() } });
  }
  return { newCount, notifiedCount };
}

const jitter = () => Math.floor(50 + Math.random() * 200);

const scheduleBackoff = (walletId: string, now: number, status?: number) => {
  const current = walletSchedule.get(walletId) ?? { nextPollAt: 0, backoffMs: 0 };
  const nextBackoff =
    status === 429
      ? Math.min(Math.max(BASE_POLL_INTERVAL_MS, current.backoffMs * 2 || BASE_POLL_INTERVAL_MS), MAX_BACKOFF_MS)
      : Math.min(MAX_BACKOFF_MS, Math.max(1000, current.backoffMs));
  walletSchedule.set(walletId, { nextPollAt: now + nextBackoff, backoffMs: nextBackoff });
};

const scheduleNext = (walletId: string, now: number, intervalMs: number) => {
  walletSchedule.set(walletId, { nextPollAt: now + intervalMs, backoffMs: 0 });
};

const extractWsAddress = (payload: Record<string, unknown>): string | null => {
  const direct = payload.account ?? payload.address ?? payload.account_id ?? payload.addr;
  if (typeof direct === "string") return direct;
  const params = payload.params;
  if (params && typeof params === "object") {
    const paramsRecord = params as Record<string, unknown>;
    const nested = paramsRecord.account ?? paramsRecord.address ?? paramsRecord.account_id ?? paramsRecord.addr;
    if (typeof nested === "string") return nested;
  }
  return null;
};

const extractWsMeta = (payload: Record<string, unknown>) => {
  const txHash = payload.tx_hash ?? payload.txHash;
  const txHashFromTx =
    typeof payload.transaction === "object" && payload.transaction
      ? (payload.transaction as Record<string, unknown>).hash
      : undefined;
  const params = payload.params;
  const paramsTxHash =
    params && typeof params === "object" ? (params as Record<string, unknown>).tx_hash : undefined;
  const lt = payload.lt ?? payload.tx_lt;
  const paramsLt = params && typeof params === "object" ? (params as Record<string, unknown>).lt : undefined;
  return {
    txHash: typeof txHash === "string" ? txHash : typeof txHashFromTx === "string" ? txHashFromTx : paramsTxHash,
    lt: typeof lt === "string" ? lt : typeof paramsLt === "string" ? paramsLt : undefined
  };
};

const buildWsUrl = () => {
  if (!TONCENTER_WS_URL) return null;
  try {
    const url = new URL(TONCENTER_WS_URL);
    if (TONCENTER_API_KEY) {
      url.searchParams.set("api_key", TONCENTER_API_KEY);
    }
    return url.toString();
  } catch {
    return null;
  }
};

type WebhookQueueItem = {
  payload: WebhookPayload;
  receivedAt: number;
  hint: ReturnType<typeof extractWebhookHint>;
};

const createWebhookQueue = (handler: (item: WebhookQueueItem) => Promise<void>) => {
  const inFlight = new Set<string>();
  const pending = new Map<string, WebhookQueueItem>();

  const run = (key: string) => {
    if (inFlight.has(key)) return;
    const item = pending.get(key);
    if (!item) return;
    pending.delete(key);
    inFlight.add(key);
    void handler(item)
      .catch((error) => logger.warn({ error, key }, "webhook processing failed"))
      .finally(() => {
        inFlight.delete(key);
        if (pending.has(key)) {
          run(key);
        }
      });
  };

  return {
    enqueue: (payload: WebhookPayload) => {
      const hint = extractWebhookHint(payload);
      const key = hint.txHash ?? `${hint.accountId ?? "unknown"}:${hint.eventId ?? "unknown"}`;
      pending.set(key, { payload, receivedAt: Date.now(), hint });
      run(key);
    }
  };
};

const resolveWalletLookup = async (wallets: WsWallet[]) => {
  const entries: Array<[string, WsWallet]> = [];
  for (const wallet of wallets) {
    try {
      const raw = Address.parse(wallet.address).toRawString();
      entries.push([wallet.address, wallet], [raw, wallet]);
    } catch {
      entries.push([wallet.address, wallet]);
    }
  }
  return new Map(entries);
};

const fetchWebhookEvents = async (accountId: string, lt?: string, txHash?: string) => {
  const events = await fetchEvents(accountId, lt);
  if (!txHash) return events;
  return events.filter(
    (event) => event.event_id === txHash || event.base_transactions?.includes(txHash)
  );
};

const processWebhookFastPath = async (params: {
  wallet: ProcessWalletInput;
  notifierUser: NotifierUser;
  lang: Language;
  accountId: string;
  txHash: string;
}): Promise<{ ok: boolean; normalizedCount: number; result: ProcessWalletResult }> => {
  const tx = await fetchTonApiTransaction({
    tonapiBase: TONAPI_BASE,
    tonapiKey: TONAPI_KEY,
    txHash: params.txHash,
    limiter: tonapiLimiter
  });
  const actions = buildTonTransferActionsFromTransaction(params.accountId, tx);
  const eventLt = tx.lt ? String(tx.lt) : "0";
  if (actions.length === 0) {
    return { ok: true, normalizedCount: 0, result: createEmptyProcessResult() };
  }
  const event: TonApiEvent = {
    event_id: tx.hash ?? params.txHash,
    lt: eventLt,
    transaction: { lt: eventLt },
    base_transactions: [params.txHash],
    actions
  };
  const result = await processEventsForWallet(params.wallet, [event], params.notifierUser, params.lang, "webhook");
  return { ok: true, normalizedCount: actions.length, result };
};

const extractWebhookLt = (payload: WebhookPayload): string | undefined => {
  const directLt = payload.lt;
  if (typeof directLt === "string") return directLt;
  if (typeof directLt === "number" && Number.isFinite(directLt)) return String(directLt);
  const params = payload.params;
  if (params && typeof params === "object") {
    const value = (params as Record<string, unknown>).lt;
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
};

const userToNotifierUser = (user: { telegramId: bigint }): NotifierUser => ({
  telegramId: user.telegramId.toString()
});

const startWebhookServer = (queue: ReturnType<typeof createWebhookQueue>) => {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).send("ok");
  });

  app.post("/webhook/tonapi", (req: Request, res: Response) => {
    if (TONAPI_WEBHOOK_SECRET) {
      const headerSecret = req.header("x-tonapi-secret");
      if (headerSecret !== TONAPI_WEBHOOK_SECRET) {
        res.status(401).json({ ok: false });
        return;
      }
    }
    const payload = (req.body ?? {}) as WebhookPayload;
    const hint = extractWebhookHint(payload);
    res.status(200).json({ ok: true });
    logger.info({ txHash: hint.txHash ?? null, accountId: hint.accountId ?? null, eventId: hint.eventId ?? null }, "webhook received");
    queue.enqueue(payload);
  });

  app.listen(WEBHOOK_PORT, () => {
    logger.info({ port: WEBHOOK_PORT }, "webhook server listening");
  });
};

const rtHeaders = (): Record<string, string> => ({
  Authorization: `Bearer ${TONAPI_KEY}`,
  "Content-Type": "application/json"
});

const ensureWebhookId = async () => {
  if (!WEBHOOK_MODE || !WEBHOOK_PUBLIC_URL) return null;
  try {
    const listResponse = await fetch("https://rt.tonapi.io/webhooks", {
      headers: { Authorization: `Bearer ${TONAPI_KEY}` }
    });
    if (!listResponse.ok) {
      throw new Error(`list webhooks failed ${listResponse.status}`);
    }
    const listPayload = (await listResponse.json()) as { webhooks?: Array<{ webhook_id?: string; endpoint?: string; id?: string }> };
    const existing = (listPayload.webhooks ?? []).find((item) => item.endpoint === WEBHOOK_PUBLIC_URL);
    if (existing) {
      const webhookId = existing.webhook_id ?? existing.id ?? null;
      logger.info({ webhookId }, "webhook ensured");
      return webhookId;
    }

    const createResponse = await fetch("https://rt.tonapi.io/webhooks", {
      method: "POST",
      headers: rtHeaders(),
      body: JSON.stringify({ endpoint: WEBHOOK_PUBLIC_URL })
    });
    if (!createResponse.ok) {
      throw new Error(`create webhook failed ${createResponse.status}`);
    }
    const payload = (await createResponse.json()) as { webhook_id?: string; id?: string };
    const webhookId = payload.webhook_id ?? payload.id ?? null;
    logger.info({ webhookId }, "webhook ensured");
    return webhookId;
  } catch (error) {
    logger.warn({ error }, "webhook ensure failed");
    return null;
  }
};

const listRemoteSubscriptions = async (webhookId: string): Promise<string[]> => {
  let offset = 0;
  const limit = 1000;
  const result: string[] = [];
  while (true) {
    const response = await fetch(
      `https://rt.tonapi.io/webhooks/${webhookId}/account-tx/subscriptions?offset=${offset}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${TONAPI_KEY}` } }
    );
    if (!response.ok) {
      throw new Error(`list subscriptions failed ${response.status}`);
    }
    const payload = (await response.json()) as {
      subscriptions?: Array<{ account_id?: string } | string>;
      accounts?: Array<{ account_id?: string } | string>;
    };
    const page = (payload.subscriptions ?? payload.accounts ?? []).flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item.account_id === "string") return [item.account_id];
      return [];
    });
    result.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return result;
};

const syncWebhookSubscriptions = async (webhookId: string) => {
  const startedAt = Date.now();
  const wallets: Array<{ id: string; address: string }> = await prisma.wallet.findMany({ select: { id: true, address: true } });
  const dbAccountIds = wallets.flatMap((wallet) => {
    try {
      return [Address.parse(wallet.address).toRawString()];
    } catch {
      logger.warn({ walletId: wallet.id, address: wallet.address }, "wallet address parse failed for webhook sync");
      return [];
    }
  });

  let subscribedCount = 0;
  let unsubscribedCount = 0;
  let errorsCount = 0;
  let toRemoveCount = 0;
  try {
    const remoteAccountIds = await listRemoteSubscriptions(webhookId);
    const { toSubscribe, toUnsubscribe } = diffAccountSubscriptions(dbAccountIds, remoteAccountIds);
    toRemoveCount = toUnsubscribe.length;

    logger.debug(
      {
        dbCount: dbAccountIds.length,
        remoteCount: remoteAccountIds.length,
        toAddCount: toSubscribe.length,
        toRemoveCount
      },
      "webhook sync diff"
    );

    for (const batch of splitIntoBatches(toSubscribe, WEBHOOK_SYNC_BATCH)) {
      if (batch.length === 0) continue;
      const response = await fetch(`https://rt.tonapi.io/webhooks/${webhookId}/account-tx/subscribe`, {
        method: "POST",
        headers: rtHeaders(),
        body: JSON.stringify({ accounts: batch.map((account_id) => ({ account_id })) })
      });
      if (!response.ok) {
        errorsCount += batch.length;
        logger.warn({ status: response.status, batch: batch.length }, "webhook subscribe batch failed");
      } else {
        subscribedCount += batch.length;
      }
    }

    for (const batch of splitIntoBatches(toUnsubscribe, WEBHOOK_SYNC_BATCH)) {
      if (batch.length === 0) continue;
      const response = await fetch(`https://rt.tonapi.io/webhooks/${webhookId}/account-tx/unsubscribe`, {
        method: "POST",
        headers: rtHeaders(),
        body: JSON.stringify({ accounts: batch })
      });
      if (!response.ok) {
        if (response.status === 404 || response.status === 409) {
          unsubscribedCount += batch.length;
          logger.info({ status: response.status, batch: batch.length }, "webhook unsubscribe batch already absent");
          continue;
        }
        errorsCount += batch.length;
        logger.warn({ status: response.status, batch: batch.length }, "webhook unsubscribe batch failed");
      } else {
        unsubscribedCount += batch.length;
      }
    }
  } catch (error) {
    errorsCount += 1;
    logger.warn({ error }, "webhook sync failed");
  }

  logger.info(
    {
      subscribedCount,
      unsubscribedCount,
      toRemoveCount,
      errorsCount,
      durationMs: Date.now() - startedAt
    },
    "webhook sync summary"
  );
};

const createWebhookSyncRunner = (webhookId: string) => {
  let inFlight = false;
  let pending = false;

  const run = async () => {
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      await syncWebhookSubscriptions(webhookId);
    } finally {
      inFlight = false;
      if (pending) {
        pending = false;
        await run();
      }
    }
  };

  return {
    schedule: () => {
      void run();
    }
  };
};

let cachedWalletLookup = new Map<string, WsWallet>();
let walletLookupUpdatedAt = 0;

const refreshWalletLookup = async (): Promise<WsWallet[]> => {
  const now = Date.now();
  if (now - walletLookupUpdatedAt < 30_000 && cachedWalletLookup.size > 0) {
    return Array.from(
      new Map(Array.from(cachedWalletLookup.values()).map((wallet: WsWallet) => [wallet.id, wallet])).values()
    );
  }
  const wallets: WsWallet[] = await prisma.wallet.findMany();
  cachedWalletLookup = await resolveWalletLookup(wallets);
  walletLookupUpdatedAt = now;
  return wallets;
};

const getWalletFromLookup = async (accountId: string) => {
  await refreshWalletLookup();
  let wallet = cachedWalletLookup.get(accountId);
  if (!wallet) {
    try {
      wallet = cachedWalletLookup.get(Address.parse(accountId).toRawString());
    } catch {
      wallet = undefined;
    }
  }
  return wallet;
};

const startWebSocket = (
  walletsProvider: () => Promise<WsWallet[]>,
  walletLookup: () => Map<string, WsWallet>
) => {
  if (!WS_MODE) return;
  const wsUrl = buildWsUrl();
  if (!wsUrl) {
    logger.warn("ws mode enabled but TONCENTER_WS_URL is missing/invalid");
    return;
  }
  let reconnectDelay = 1000;
  let ws: WebSocket | null = null;
  const wsQueue = createDebouncedInFlightQueue<WsWallet>(1500, async (wallet) => {
    try {
      await processWallet(wallet);
    } catch (error) {
      logger.warn({ error }, "ws wallet processing failed");
    }
  });
  const sanitizedWsUrl = (() => {
    try {
      const safeUrl = new URL(wsUrl);
      safeUrl.searchParams.delete("api_key");
      return safeUrl.toString();
    } catch {
      return wsUrl;
    }
  })();
  const connect = async () => {
    logger.info({ url: sanitizedWsUrl }, "ws connecting");
    ws = new WebSocket(wsUrl);
    ws.on("open", async () => {
      reconnectDelay = 1000;
      logger.info("ws connected");
      try {
        const wallets = await walletsProvider();
        const accountAddresses = wallets.map((wallet) => wallet.address);
        const subscriptionPayloads = [
          {
            name: "subscribe_accounts",
            payload: { id: 2, jsonrpc: "2.0", method: "subscribe", params: { accounts: accountAddresses } }
          },
          {
            name: "subscribe_addresses",
            payload: { id: 3, jsonrpc: "2.0", method: "subscribe", params: { addresses: accountAddresses } }
          },
          {
            name: "subscribe_transactions",
            payload: { id: 4, jsonrpc: "2.0", method: "subscribeTransactions", params: { accounts: accountAddresses } }
          }
        ];
        for (const subscription of subscriptionPayloads) {
          try {
            ws?.send(JSON.stringify(subscription.payload));
            logger.info({ variant: subscription.name }, "ws subscribe attempt");
          } catch (error) {
            logger.warn({ error, variant: subscription.name }, "ws subscribe failed; polling fallback continues");
          }
        }
        logger.info({ count: wallets.length }, "ws subscribed");
      } catch (error) {
        logger.warn({ error }, "ws subscription init failed; polling fallback continues");
      }
    });
    ws.on("message", (data: RawData) => {
      try {
        const payload = JSON.parse(data.toString()) as Record<string, unknown>;
        const address = extractWsAddress(payload);
        if (address) {
          const meta = extractWsMeta(payload);
          logger.info({ address, txHash: meta.txHash ?? null, lt: meta.lt ?? null }, "ws event received");
          const lookup = walletLookup();
          let wallet = lookup.get(address);
          if (!wallet) {
            try {
              wallet = lookup.get(Address.parse(address).toRawString());
            } catch {
              wallet = undefined;
            }
          }
          if (wallet) {
            wsQueue.trigger(wallet.id, wallet);
          }
        }
      } catch (error) {
        logger.warn({ error }, "ws message parse failed");
      }
    });
    ws.on("close", async (code: number, reason: Buffer) => {
      logger.warn({ code, reason: reason.toString() }, "ws disconnected");
      await sleep(reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      connect();
    });
    ws.on("error", (error: Error) => {
      logger.warn({ error }, "ws error; polling fallback continues");
      ws?.close();
    });
  };
  connect();
};

async function poll() {
  const wallets: WsWallet[] = await prisma.wallet.findMany();
  const sample = wallets.slice(0, 2).map((wallet) => ({ id: wallet.id, address: wallet.address }));
  if (wallets.length === 0) {
    const now = Date.now();
    if (now - lastEmptyWalletLogAt > 60_000) {
      logger.info("0 wallets tracked");
      lastEmptyWalletLogAt = now;
    }
    return { walletsCount: 0, newEvents: 0, notified: 0 };
  }
  const now = Date.now();
  const dueWallets = wallets.filter((wallet) => {
    const schedule = walletSchedule.get(wallet.id);
    return !schedule || schedule.nextPollAt <= now;
  });
  const nextScheduled = wallets.reduce((next, wallet) => {
    const schedule = walletSchedule.get(wallet.id);
    if (!schedule) return next;
    if (!next || schedule.nextPollAt < next.nextPollAt) {
      return { id: wallet.id, nextPollAt: schedule.nextPollAt };
    }
    return next;
  }, undefined as { id: string; nextPollAt: number } | undefined);

  if (now - lastScheduleLogAt > 15000) {
    lastScheduleLogAt = now;
    const limiterSnapshot = tonapiLimiter.snapshot();
    logger.info(
      {
        inflight: limiterSnapshot.inflight,
        effectiveRps: limiterSnapshot.effectiveRps,
        cooldownActive: limiterSnapshot.cooldownActive,
        dueCount: dueWallets.length,
        nextWallet: nextScheduled?.id ?? null,
        nextPollAt: nextScheduled?.nextPollAt ?? null
      },
      "wallet scheduler"
    );
  }

  logger.info({ count: wallets.length, dueCount: dueWallets.length, sample }, "poll tick");
  tonapiLimiter.logIfNeeded(logger);
  let newEvents = 0;
  let notified = 0;
  for (let i = 0; i < dueWallets.length; i += MAX_PARALLEL_WALLETS) {
    const batch = dueWallets.slice(i, i + MAX_PARALLEL_WALLETS);
    const results = await Promise.all(batch.map((wallet) => processWallet(wallet)));
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const wallet = batch[index];
      if (!result) continue;
      newEvents += result.newCount;
      notified += result.notifiedCount;
      if (result.errorStatus) {
        scheduleBackoff(wallet.id, now, result.errorStatus);
        continue;
      }
      const intervalMs =
        result.newCount > 0 && FAST_POLLING_ENABLED ? FAST_POLL_INTERVAL_MS : BASE_POLL_INTERVAL_MS;
      scheduleNext(wallet.id, now, intervalMs);
    }
    await sleep(200 + jitter());
  }
  return { walletsCount: wallets.length, newEvents, notified };
}

async function start() {
  logger.info(
    {
      wsMode: WS_MODE,
      toncenterWsConfigured: Boolean(TONCENTER_WS_URL),
      webhooksConfigured: WEBHOOK_MODE,
      webhookPublicUrl: WEBHOOK_PUBLIC_URL ?? null
    },
    "watcher started"
  );
  let backoffMs = 0;
  let nextInterval = BASE_POLL_INTERVAL_MS;
  const webhookQueue = createWebhookQueue(async ({ payload, receivedAt, hint }) => {
    const accountId = hint.accountId;
    if (!accountId) {
      logger.warn({ txHash: hint.txHash ?? null, eventId: hint.eventId ?? null }, "webhook payload missing account_id");
      return;
    }
    const wallet = await getWalletFromLookup(accountId);
    if (!wallet) {
      logger.warn({ accountId }, "webhook wallet not tracked");
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: wallet.userId } });
    if (!user) return;
    const lang = (user.language as Language) ?? DEFAULT_LANGUAGE;
    const notifierUser = userToNotifierUser(user);
    let fallbackUsed = false;
    let normalizedCount = 0;
    let result: ProcessWalletResult = { newCount: 0, notifiedCount: 0 };
    const fastStart = Date.now();
    if (FAST_MODE && hint.txHash) {
      try {
        const fast = await processWebhookFastPath({ wallet, notifierUser, lang, accountId, txHash: hint.txHash });
        normalizedCount = fast.normalizedCount;
        result = fast.result;
      } catch (error) {
        fallbackUsed = true;
        logger.warn({ error, txHash: hint.txHash, accountId }, "webhook fast-path failed, fallback");
      }
    } else {
      fallbackUsed = true;
    }

    if (fallbackUsed) {
      let events: TonApiEvent[] = [];
      try {
        events = await fetchWebhookEvents(accountId, extractWebhookLt(payload), hint.txHash);
      } catch (error) {
        logger.warn({ error, accountId }, "webhook fetch failed");
        return;
      }
      result = await processEventsForWallet(wallet, events, notifierUser, lang, "webhook");
      normalizedCount = events.reduce((sum, event) => sum + (event.actions?.length ?? 0), 0);
    }

    logger.info(
      {
        txHash: hint.txHash ?? null,
        ok: !fallbackUsed,
        durationMs: Date.now() - fastStart,
        normalizedCount,
        fallbackUsed
      },
      "webhook fast-path"
    );

    logger.info(
      {
        accountId,
        txHash: hint.txHash ?? null,
        lt: extractWebhookLt(payload) ?? null,
        durationMs: Date.now() - receivedAt,
        newCount: result.newCount,
        notifiedCount: result.notifiedCount
      },
      "webhook processed"
    );
  });

  startWebhookServer(webhookQueue);

  if (WEBHOOK_MODE) {
    const webhookId = await ensureWebhookId();
    if (!webhookId) {
      logger.warn("webhooks configured but webhook id could not be resolved");
    } else {
      const syncRunner = createWebhookSyncRunner(webhookId);
      syncRunner.schedule();
      setInterval(() => {
        syncRunner.schedule();
      }, WEBHOOK_SYNC_INTERVAL_MS);
    }
  } else if (WEBHOOK_PUBLIC_URL || TONAPI_KEY) {
    logger.warn("webhooks partially configured; polling fallback active");
  }

  let wsWalletLookup = cachedWalletLookup;
  if (WS_MODE) {
    startWebSocket(
      async () => {
        await refreshWalletLookup();
        wsWalletLookup = cachedWalletLookup;
        return Array.from(
          new Map(Array.from(cachedWalletLookup.values()).map((wallet: WsWallet) => [wallet.id, wallet])).values()
        );
      },
      () => wsWalletLookup
    );
  }
  while (true) {
    const startAt = Date.now();
    try {
      const result = await poll();
      if (result) {
        nextInterval = result.newEvents > 0 && FAST_POLLING_ENABLED ? FAST_POLL_INTERVAL_MS : BASE_POLL_INTERVAL_MS;
      }
      backoffMs = 0;
    } catch (error) {
      logger.error({ error }, "poll error");
      backoffMs = Math.min(Math.max(BASE_POLL_INTERVAL_MS, backoffMs * 2 || BASE_POLL_INTERVAL_MS), MAX_BACKOFF_MS);
    }
    const elapsed = Date.now() - startAt;
    const wait = Math.max(nextInterval + backoffMs - elapsed + jitter(), 1000);
    await sleep(wait);
  }
}

start().catch((error) => {
  logger.error({ error }, "watcher failed");
  process.exit(1);
});
