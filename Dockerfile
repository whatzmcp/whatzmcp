# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
# Build tools only for the rare case where no prebuilt SQLite binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
LABEL io.modelcontextprotocol.server.name="io.github.whatzmcp/whatzmcp" \
      org.opencontainers.image.source="https://github.com/whatzmcp/whatzmcp" \
      org.opencontainers.image.description="Self-hosted WhatsApp MCP server" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    WHATZMCP_HOME=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE ./
COPY contract ./contract
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve"]
