export const splitIntoBatches = (items, size) => {
  if (size <= 0) return [items];
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
};

export const diffAccountSubscriptions = (dbAccountIds, remoteAccountIds) => {
  const dbSet = new Set(dbAccountIds);
  const remoteSet = new Set(remoteAccountIds);

  const toSubscribe = dbAccountIds.filter((accountId) => !remoteSet.has(accountId));
  const toUnsubscribe = remoteAccountIds.filter((accountId) => !dbSet.has(accountId));

  return { toSubscribe, toUnsubscribe };
};
