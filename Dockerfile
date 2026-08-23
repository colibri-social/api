FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
ENV PIP_BREAK_SYSTEM_PACKAGES=1
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		build-essential \
		python3 \
		python3-pip \
	&& rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/appview/package.json apps/appview/
COPY apps/migrate/package.json apps/migrate/
COPY packages/blobs/package.json packages/blobs/
COPY packages/community/package.json packages/community/
COPY packages/db/package.json packages/db/
COPY packages/embeds/package.json packages/embeds/
COPY packages/identity/package.json packages/identity/
COPY packages/lexicons/package.json packages/lexicons/
COPY packages/notifications/package.json packages/notifications/
COPY packages/projections/package.json packages/projections/
COPY packages/space/package.json packages/space/
COPY packages/space-sync/package.json packages/space-sync/
COPY packages/voice/package.json packages/voice/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

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
ENV DATABASE_URL=file:/data/colibri.db
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/appview/dist/index.js"]
