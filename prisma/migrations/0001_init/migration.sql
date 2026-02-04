-- CreateEnum
CREATE TYPE "UserStep" AS ENUM ('NONE', 'ADD_ADDRESS', 'ADD_NAME', 'EDIT_RENAME', 'EDIT_CHANGE_ADDRESS');

-- CreateEnum
CREATE TYPE "EventDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('TON', 'JETTON', 'NFT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "language" TEXT NOT NULL DEFAULT 'ru',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "lastEventLt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "step" "UserStep" NOT NULL DEFAULT 'NONE',
    "tempAddress" TEXT,
    "tempWalletId" TEXT,

    CONSTRAINT "UserState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletEvent" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "type" "EventType" NOT NULL,
    "direction" "EventDirection" NOT NULL,
    "asset" TEXT NOT NULL,
    "amount" TEXT,
    "counterparty" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE INDEX "Wallet_userId_idx" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserState_userId_key" ON "UserState"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletEvent_walletId_txHash_actionId_key" ON "WalletEvent"("walletId", "txHash", "actionId");

-- CreateIndex
CREATE INDEX "WalletEvent_walletId_idx" ON "WalletEvent"("walletId");

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserState" ADD CONSTRAINT "UserState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletEvent" ADD CONSTRAINT "WalletEvent_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
