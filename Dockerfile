# apps/server: API, scheduler, workers, resolver. No Foundry needed: packages/shared/src/generated.ts
# is committed, so run `pnpm deploy:base` (which regenerates it) and commit before building.
FROM node:20.20.2-slim
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @starter/server...
ENV NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "--filter", "@starter/server", "start"]
