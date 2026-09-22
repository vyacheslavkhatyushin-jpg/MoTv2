FROM node:20-bookworm-slim

# assimp-utils — конвертация DXF → glTF/glb "из коробки", без своего парсера.
RUN apt-get update \
 && apt-get install -y --no-install-recommends assimp-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public/ ./public/

VOLUME ["/app/data"]

EXPOSE 3100
CMD ["node", "server.js"]
