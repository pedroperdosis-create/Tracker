export const splitIntoBatches = <T>(items: T[], size: number): T[][] => {
  if (size <= 0) return [items];
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
};

export const diffAccountSubscriptions = (dbAccountIds: string[], remoteAccountIds: string[]) => {
  const dbDistinct = Array.from(new Set(dbAccountIds));
  const remoteDistinct = Array.from(new Set(remoteAccountIds));
  const dbSet = new Set(dbDistinct);
  const remoteSet = new Set(remoteDistinct);

  const toSubscribe = dbDistinct.filter((accountId) => !remoteSet.has(accountId));
  const toUnsubscribe = remoteDistinct.filter((accountId) => !dbSet.has(accountId));

  return { toSubscribe, toUnsubscribe };
};
