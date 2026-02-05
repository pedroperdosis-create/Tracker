export type WebhookPayload = Record<string, unknown>;

export type WebhookHint = {
  txHash?: string;
  accountId?: string;
  eventId?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const asString = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

export const extractWebhookHint = (payload: WebhookPayload): WebhookHint => {
  const directTxHash = asString(payload.tx_hash) ?? asString(payload.txHash) ?? asString(payload.hash);
  const directAccount =
    asString(payload.account_id) ?? asString(payload.account) ?? asString(payload.address) ?? asString(payload.wallet);
  const directEventId = asString(payload.event_id) ?? asString(payload.eventId) ?? asString(payload.id);

  const params = asRecord(payload.params);
  const data = asRecord(payload.data);
  const event = asRecord(payload.event);

  const nestedTxHash =
    (params && (asString(params.tx_hash) ?? asString(params.txHash) ?? asString(params.hash))) ??
    (data && (asString(data.tx_hash) ?? asString(data.txHash) ?? asString(data.hash))) ??
    (event && (asString(event.tx_hash) ?? asString(event.txHash) ?? asString(event.hash)));

  const nestedAccount =
    (params &&
      (asString(params.account_id) ?? asString(params.account) ?? asString(params.address) ?? asString(params.wallet))) ??
    (data &&
      (asString(data.account_id) ?? asString(data.account) ?? asString(data.address) ?? asString(data.wallet))) ??
    (event &&
      (asString(event.account_id) ?? asString(event.account) ?? asString(event.address) ?? asString(event.wallet)));

  const nestedEventId =
    (event && (asString(event.event_id) ?? asString(event.eventId) ?? asString(event.id))) ??
    (data && (asString(data.event_id) ?? asString(data.eventId) ?? asString(data.id))) ??
    (params && (asString(params.event_id) ?? asString(params.eventId) ?? asString(params.id)));

  const txHash = directTxHash ?? nestedTxHash ?? undefined;
  const accountId = directAccount ?? nestedAccount ?? undefined;
  const eventId = directEventId ?? nestedEventId ?? undefined;

  return { txHash, accountId, eventId };
};
