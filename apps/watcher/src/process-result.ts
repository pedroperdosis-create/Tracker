export type ProcessWalletResult = { newCount: number; notifiedCount: number; errorStatus?: number };

export const createEmptyProcessResult = (): ProcessWalletResult => ({
  newCount: 0,
  notifiedCount: 0
});
