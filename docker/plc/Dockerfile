FROM node:24-bookworm-slim

WORKDIR /srv
RUN npm install --omit=dev --no-audit --no-fund @did-plc/server@0.0.1

COPY server.mjs ./server.mjs

ENV PORT=2582
EXPOSE 2582
CMD ["node", "server.mjs"]
