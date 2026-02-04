FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* tsconfig.base.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY apps/watcher/package.json apps/watcher/package.json
COPY packages/common/package.json packages/common/package.json
COPY prisma/schema.prisma prisma/schema.prisma
COPY prisma/migrations prisma/migrations
RUN npm install
COPY apps apps
COPY packages packages
COPY prisma prisma
RUN npm run prisma:generate
RUN npm run build -w packages/common && npm run build -w apps/bot && npm run build -w apps/watcher

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/apps ./apps
COPY --from=base /app/packages ./packages
COPY --from=base /app/prisma ./prisma
COPY package.json ./
CMD ["node", "apps/bot/dist/index.js"]
