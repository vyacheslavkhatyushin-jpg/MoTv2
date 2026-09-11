FROM node:20-bookworm-slim

# python3/make/g++ — фолбэк на случай, если для better-sqlite3 не найдётся
# готовый прекомпилированный бинарник под платформу образа (тогда npm
# соберёт нативный модуль из исходников через node-gyp).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server

COPY server/package*.json ./
RUN npm install --omit=dev

COPY server/ ./
COPY public/ ../public/

VOLUME ["/app/server/data"]

EXPOSE 3000
CMD ["node", "server.js"]
