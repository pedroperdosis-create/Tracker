import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { prisma } from "./db";
import { DEFAULT_LANGUAGE, Language, t, isValidAddress, normalizeAddress, shortAddress, addressLink } from "@tracker/common";
import pino from "pino";

const logger = pino({ name: "bot" });

const token = process.env.BOT_TOKEN;
if (!token) {
  throw new Error("BOT_TOKEN is required");
}

const bot = new Telegraf(token);

const menuKeyboard = (lang: Language) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(t(lang, "add"), "menu:add"), Markup.button.callback(t(lang, "edit"), "menu:edit")],
    [Markup.button.callback(t(lang, "wallets"), "menu:wallets"), Markup.button.callback(t(lang, "language"), "menu:language")]
  ]);

const backKeyboard = (lang: Language) =>
  Markup.inlineKeyboard([[Markup.button.callback(t(lang, "back"), "menu:back")]]);

const noPreviewOptions = { link_preview_options: { is_disabled: true } };

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const isMessageNotModifiedError = (error: unknown) => {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { response?: { error_code?: number; description?: string } };
  const errorCode = maybeError.response?.error_code;
  const description = maybeError.response?.description ?? "";
  return errorCode === 400 && description.toLowerCase().includes("message is not modified");
};

const safeEditMessageText = async (ctx: any, text: string, extra?: Parameters<typeof ctx.editMessageText>[1]) => {
  try {
    await ctx.editMessageText(text, { ...noPreviewOptions, ...(extra ?? {}) });
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      return;
    }
    throw error;
  }
};

async function getOrCreateUser(telegramId: bigint, ctxUser: { username?: string; first_name?: string; last_name?: string }) {
  const existing = await prisma.user.findUnique({ where: { telegramId } });
  if (existing) {
    return existing;
  }
  const created = await prisma.user.create({
    data: {
      telegramId,
      username: ctxUser.username,
      firstName: ctxUser.first_name,
      lastName: ctxUser.last_name
    }
  });
  await prisma.userState.create({ data: { userId: created.id } });
  return created;
}

async function ensureState(userId: string) {
  const state = await prisma.userState.findUnique({ where: { userId } });
  if (state) {
    return state;
  }
  return prisma.userState.create({ data: { userId } });
}

async function sendMenu(ctx: any, lang: Language) {
  const text = t(lang, "menuTitle");
  if (ctx.updateType === "callback_query") {
    await safeEditMessageText(ctx, text, menuKeyboard(lang));
    return;
  }
  await ctx.reply(text, { ...menuKeyboard(lang), ...noPreviewOptions });
}

bot.start(async (ctx) => {
  const telegramId = BigInt(ctx.from.id);
  const user = await getOrCreateUser(telegramId, ctx.from);
  await sendMenu(ctx, user.language as Language);
});

bot.command("cancel", async (ctx) => {
  const user = await getOrCreateUser(BigInt(ctx.from.id), ctx.from);
  await prisma.userState.update({ where: { userId: user.id }, data: { step: "NONE", tempAddress: null, tempWalletId: null } });
  await ctx.reply(t(user.language as Language, "actionCanceled"), {
    ...menuKeyboard(user.language as Language),
    ...noPreviewOptions
  });
});

bot.on("callback_query", async (ctx) => {
  const telegramId = BigInt(ctx.from.id);
  const user = await getOrCreateUser(telegramId, ctx.from);
  const lang = user.language as Language;
  const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data ?? "" : "";

  if (data === "menu:back") {
    await sendMenu(ctx, lang);
    return;
  }

  if (data === "menu:add") {
    await prisma.userState.update({ where: { userId: user.id }, data: { step: "ADD_ADDRESS", tempAddress: null } });
    await safeEditMessageText(ctx, t(lang, "addAddressPrompt"), backKeyboard(lang));
    return;
  }

  if (data === "menu:edit") {
    const wallets = await prisma.wallet.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    if (wallets.length === 0) {
      await safeEditMessageText(ctx, t(lang, "walletsEmpty"), menuKeyboard(lang));
      return;
    }
    const buttons = wallets.map((wallet) => [Markup.button.callback(wallet.name, `wallet:edit:${wallet.id}`)]);
    buttons.push([Markup.button.callback(t(lang, "back"), "menu:back")]);
    await safeEditMessageText(ctx, t(lang, "editChooseWallet"), Markup.inlineKeyboard(buttons));
    return;
  }

  if (data === "menu:wallets") {
    const wallets = await prisma.wallet.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    if (wallets.length === 0) {
      await safeEditMessageText(ctx, t(lang, "walletsEmpty"), menuKeyboard(lang));
      return;
    }
    const lines = wallets.map((wallet) => `${wallet.name} · ${shortAddress(normalizeAddress(wallet.address))}`);
    const buttons = wallets.map((wallet) => [
      Markup.button.url(
        `${wallet.name} · ${shortAddress(normalizeAddress(wallet.address))}`,
        addressLink(normalizeAddress(wallet.address))
      )
    ]);
    await safeEditMessageText(ctx, `${t(lang, "walletsTitle")}\n\n${lines.join("\n")}`, Markup.inlineKeyboard(buttons));
    return;
  }

  if (data === "menu:language") {
    await safeEditMessageText(
      ctx,
      t(lang, "languageTitle"),
      Markup.inlineKeyboard([
        [Markup.button.callback("Русский", "lang:ru"), Markup.button.callback("English", "lang:en")],
        [Markup.button.callback(t(lang, "back"), "menu:back")]
      ])
    );
    return;
  }

  if (data.startsWith("lang:")) {
    const nextLang = data.split(":")[1] as Language;
    await prisma.user.update({ where: { id: user.id }, data: { language: nextLang } });
    await safeEditMessageText(ctx, t(nextLang, "languageSaved"), menuKeyboard(nextLang));
    return;
  }

  if (data.startsWith("wallet:edit:")) {
    const walletId = data.split(":")[2];
    const wallet = await prisma.wallet.findFirst({ where: { id: walletId, userId: user.id } });
    if (!wallet) {
      await safeEditMessageText(ctx, t(lang, "walletsEmpty"), menuKeyboard(lang));
      return;
    }
    await safeEditMessageText(
      ctx,
      `${escapeHtml(wallet.name)}\n${t(lang, "editChooseAction")}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, "editRename"), `wallet:action:rename:${wallet.id}`)],
        [Markup.button.callback(t(lang, "editChangeAddress"), `wallet:action:address:${wallet.id}`)],
        [Markup.button.callback(t(lang, "editDelete"), `wallet:action:delete:${wallet.id}`)],
        [Markup.button.callback(t(lang, "back"), "menu:edit")]
      ])
    );
    return;
  }

  if (data.startsWith("wallet:action:rename:")) {
    const walletId = data.split(":")[3];
    await prisma.userState.update({ where: { userId: user.id }, data: { step: "EDIT_RENAME", tempWalletId: walletId } });
    await safeEditMessageText(ctx, t(lang, "selectWalletToRename"), backKeyboard(lang));
    return;
  }

  if (data.startsWith("wallet:action:address:")) {
    const walletId = data.split(":")[3];
    await prisma.userState.update({ where: { userId: user.id }, data: { step: "EDIT_CHANGE_ADDRESS", tempWalletId: walletId } });
    await safeEditMessageText(ctx, t(lang, "selectWalletToChangeAddress"), backKeyboard(lang));
    return;
  }

  if (data.startsWith("wallet:action:delete:")) {
    const walletId = data.split(":")[3];
    await prisma.wallet.deleteMany({ where: { id: walletId, userId: user.id } });
    await safeEditMessageText(ctx, t(lang, "editDeleted"), menuKeyboard(lang));
    return;
  }
});

bot.on("text", async (ctx) => {
  const telegramId = BigInt(ctx.from.id);
  const user = await getOrCreateUser(telegramId, ctx.from);
  const state = await ensureState(user.id);
  const lang = user.language as Language;
  const text = ctx.message.text.trim();

  if (state.step === "ADD_ADDRESS") {
    if (!isValidAddress(text)) {
      await ctx.reply(t(lang, "addInvalidAddress"), noPreviewOptions);
      return;
    }
    await prisma.userState.update({
      where: { userId: user.id },
      data: { step: "ADD_NAME", tempAddress: normalizeAddress(text) }
    });
    await ctx.reply(t(lang, "addNamePrompt"), noPreviewOptions);
    return;
  }

  if (state.step === "ADD_NAME") {
    if (!state.tempAddress) {
      await prisma.userState.update({ where: { userId: user.id }, data: { step: "ADD_ADDRESS" } });
      await ctx.reply(t(lang, "addAddressPrompt"), noPreviewOptions);
      return;
    }
    await prisma.wallet.create({
      data: {
        userId: user.id,
        name: text,
        address: state.tempAddress
      }
    });
    await prisma.userState.update({ where: { userId: user.id }, data: { step: "NONE", tempAddress: null } });
    await ctx.reply(t(lang, "addSaved"), { ...menuKeyboard(lang), ...noPreviewOptions });
    return;
  }

  if (state.step === "EDIT_RENAME") {
    if (!state.tempWalletId) {
      await prisma.userState.update({ where: { userId: user.id }, data: { step: "NONE" } });
      await ctx.reply(t(lang, "actionCanceled"), { ...menuKeyboard(lang), ...noPreviewOptions });
      return;
    }
    await prisma.wallet.updateMany({ where: { id: state.tempWalletId, userId: user.id }, data: { name: text } });
    await prisma.userState.update({ where: { userId: user.id }, data: { step: "NONE", tempWalletId: null } });
    await ctx.reply(t(lang, "editUpdated"), { ...menuKeyboard(lang), ...noPreviewOptions });
    return;
  }

  if (state.step === "EDIT_CHANGE_ADDRESS") {
    if (!state.tempWalletId) {
      await prisma.userState.update({ where: { userId: user.id }, data: { step: "NONE" } });
      await ctx.reply(t(lang, "actionCanceled"), { ...menuKeyboard(lang), ...noPreviewOptions });
      return;
    }
    if (!isValidAddress(text)) {
      await ctx.reply(t(lang, "addInvalidAddress"), noPreviewOptions);
      return;
    }
    await prisma.wallet.updateMany({
      where: { id: state.tempWalletId, userId: user.id },
      data: { address: normalizeAddress(text) }
    });
    await prisma.userState.update({ where: { userId: user.id }, data: { step: "NONE", tempWalletId: null } });
    await ctx.reply(t(lang, "editUpdated"), { ...menuKeyboard(lang), ...noPreviewOptions });
    return;
  }
});

bot.catch((err, ctx) => {
  logger.error({ err, update: ctx.update }, "bot error");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

bot.launch().then(() => logger.info("bot started"));
