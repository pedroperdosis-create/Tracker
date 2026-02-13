ALTER TABLE "WalletEvent" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "WalletEvent_dedupeKey_key" ON "WalletEvent"("dedupeKey");
