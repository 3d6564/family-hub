FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production DATABASE_PATH=/data/family-hub.sqlite
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
CMD ["node","src/server.js"]
