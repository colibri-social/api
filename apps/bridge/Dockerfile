FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/bridge/package.json apps/bridge/
COPY packages/bridge-core/package.json packages/bridge-core/
COPY packages/bridge-discord/package.json packages/bridge-discord/
COPY packages/lexicons/package.json packages/lexicons/
RUN pnpm install --frozen-lockfile --filter "@colibri-social/bridge..."

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/lexicons packages/lexicons
COPY packages/bridge-core packages/bridge-core
COPY packages/bridge-discord packages/bridge-discord
COPY apps/bridge apps/bridge
RUN pnpm exec tsc --build apps/bridge

FROM base AS runtime
ENV NODE_ENV=production
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates tini \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd --system --create-home --shell /usr/sbin/nologin colibri

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /data && chown colibri:colibri /data
USER colibri
VOLUME ["/data"]
ENV BRIDGE_DATABASE_PATH=/data/bridge.sqlite

ENTRYPOINT ["/usr/bin/tini", "--", "node", "apps/bridge/dist/index.js"]
CMD ["run"]
