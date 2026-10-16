FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ARG FAMILY_HUB_VERSION=0.0.0
ARG FAMILY_HUB_REVISION=unknown
ARG FAMILY_HUB_CREATED=unknown
ARG FAMILY_HUB_CHANNEL=development
ENV NODE_ENV=production DATABASE_PATH=/data/family-hub.sqlite \
    FAMILY_HUB_VERSION=$FAMILY_HUB_VERSION \
    FAMILY_HUB_REVISION=$FAMILY_HUB_REVISION \
    FAMILY_HUB_CREATED=$FAMILY_HUB_CREATED \
    FAMILY_HUB_CHANNEL=$FAMILY_HUB_CHANNEL
LABEL org.opencontainers.image.title="Family Hub" \
      org.opencontainers.image.source="https://github.com/3d6564/family-hub" \
      org.opencontainers.image.version=$FAMILY_HUB_VERSION \
      org.opencontainers.image.revision=$FAMILY_HUB_REVISION \
      org.opencontainers.image.created=$FAMILY_HUB_CREATED
WORKDIR /app
RUN groupadd -r hub && useradd -r -g hub hub && mkdir /data && chown hub:hub /data
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY src ./src
COPY public ./public
USER hub
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health/ready`).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node","src/server.js"]
