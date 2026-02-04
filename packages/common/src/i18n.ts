export type Language = "ru" | "en";

export const DEFAULT_LANGUAGE: Language = "ru";

const messages = {
  ru: {
    menuTitle: "Главное меню",
    add: "➕ Добавить",
    edit: "✏️ Редактировать",
    wallets: "👛 Кошельки",
    language: "🌐 Язык",
    back: "⬅️ Назад",
    cancel: "Отмена",
    addAddressPrompt: "Введите TON-адрес кошелька:",
    addNamePrompt: "Введите имя кошелька:",
    addSaved: "Кошелёк сохранён ✅",
    addInvalidAddress: "Неверный формат TON-адреса. Попробуйте ещё раз.",
    editChooseWallet: "Выберите кошелёк:",
    editChooseAction: "Что сделать?",
    editRename: "Переименовать",
    editChangeAddress: "Изменить адрес",
    editDelete: "Удалить",
    editDeleted: "Кошелёк удалён ✅",
    editUpdated: "Кошелёк обновлён ✅",
    walletsEmpty: "Пока нет кошельков. Нажмите «Добавить».",
    walletsTitle: "Ваши кошельки:",
    languageTitle: "Выберите язык:",
    languageSaved: "Язык обновлён ✅",
    received: "Получено",
    sent: "Отправлено",
    ton: "TON",
    jetton: "Jetton",
    nft: "NFT",
    txHash: "Tx hash",
    from: "От",
    to: "На",
    unknown: "Неизвестно",
    maestroNote: "Buy with Maestro (Pro)",
    walletLine: "{name} · {address}",
    walletTitle: "{name} · {asset}",
    nftLine: "{direction}: {count} NFT {name} ({collection})",
    walletLinkLabel: "Открыть",
    selectWalletToRename: "Введите новое имя:",
    selectWalletToChangeAddress: "Введите новый TON-адрес:",
    actionCanceled: "Действие отменено.",
    addressLabel: "Адрес",
    nameLabel: "Имя",
    directionIn: "Получено",
    directionOut: "Отправлено"
  },
  en: {
    menuTitle: "Main menu",
    add: "➕ Add",
    edit: "✏️ Edit",
    wallets: "👛 Wallets",
    language: "🌐 Language",
    back: "⬅️ Back",
    cancel: "Cancel",
    addAddressPrompt: "Enter TON wallet address:",
    addNamePrompt: "Enter wallet name:",
    addSaved: "Wallet saved ✅",
    addInvalidAddress: "Invalid TON address format. Try again.",
    editChooseWallet: "Select wallet:",
    editChooseAction: "Choose action:",
    editRename: "Rename",
    editChangeAddress: "Change address",
    editDelete: "Delete",
    editDeleted: "Wallet deleted ✅",
    editUpdated: "Wallet updated ✅",
    walletsEmpty: "No wallets yet. Tap Add.",
    walletsTitle: "Your wallets:",
    languageTitle: "Select language:",
    languageSaved: "Language updated ✅",
    received: "Received",
    sent: "Sent",
    ton: "TON",
    jetton: "Jetton",
    nft: "NFT",
    txHash: "Tx hash",
    from: "From",
    to: "To",
    unknown: "Unknown",
    maestroNote: "Buy with Maestro (Pro)",
    walletLine: "{name} · {address}",
    walletTitle: "{name} · {asset}",
    nftLine: "{direction}: {count} NFT {name} ({collection})",
    walletLinkLabel: "Open",
    selectWalletToRename: "Enter new name:",
    selectWalletToChangeAddress: "Enter new TON address:",
    actionCanceled: "Action cancelled.",
    addressLabel: "Address",
    nameLabel: "Name",
    directionIn: "Received",
    directionOut: "Sent"
  }
} as const;

export type MessageKey = keyof typeof messages["ru"];

export function t(lang: Language, key: MessageKey, vars?: Record<string, string | number>): string {
  const template = messages[lang][key] ?? messages[DEFAULT_LANGUAGE][key];
  if (!vars) {
    return template;
  }
  const entries = Object.entries(vars) as Array<[string, string | number]>;
  return entries.reduce<string>(
    (acc, [varKey, value]) => acc.replace(`{${varKey}}`, String(value)),
    template
  );
}
