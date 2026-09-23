# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

# Прокси на этапе СБОРКИ образа — отдельный механизм от `environment:` в
# docker-compose.yml (тот действует только во время запуска контейнера,
# на apt-get/npm install во время build вообще не влияет). Docker сам
# умеет пробрасывать HTTP_PROXY/HTTPS_PROXY из окружения хоста как build
# args БЕЗ явного объявления в docker-compose.yml — но только если они
# видны переменными окружения именно там, откуда вызывается `docker
# compose build`/`up --build` (см. docs/backup-setup.md, диагностика
# "долгая пересборка"). ARG тут просто делает их доступными внутри
# Dockerfile — apt-get и npm сами читают их как обычные переменные
# окружения (ENV ниже), никакого спец-кода не нужно, в отличие от нашего
# собственного fetch() в рантайме.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV HTTP_PROXY=$HTTP_PROXY
ENV HTTPS_PROXY=$HTTPS_PROXY

# python3/make/g++ — фолбэк на случай, если для better-sqlite3 не найдётся
# готовый прекомпилированный бинарник под платформу образа (тогда npm
# соберёт нативный модуль из исходников через node-gyp).
# iputils-ping — нужен ping-воркеру мониторинга (server/monitor/ping-worker.js).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ iputils-ping \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server

COPY server/package*.json ./
# Кэш-маунт npm (BuildKit) — переживает изменение package.json между
# сборками: даже при инвалидации этого слоя (новая/обновлённая зависимость)
# npm не тянет из сети то, что уже когда-то скачивал, а better-sqlite3
# по-прежнему пересобирается/перелинковывается по необходимости. На особо
# долгую пересборку (полностью новый пакет вроде better-sqlite3 в первый
# раз) не повлияет, но на "поменяли одну зависимость, остальные те же"
# должно быть ощутимо быстрее, особенно за небыстрым прокси.
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev

COPY server/ ./
COPY public/ ../public/

VOLUME ["/app/server/data"]

EXPOSE 3000
CMD ["node", "server.js"]
