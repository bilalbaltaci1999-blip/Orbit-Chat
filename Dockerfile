FROM node:26-alpine AS build
RUN apk upgrade --no-cache
# better-sqlite3 yerel modülü musl üzerinde derlendiği için derleme araç zinciri gerekir.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm install
# Yalnızca kaynak dosyalar kopyalanır; yerel node_modules/data imaja sızmaz.
COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY client ./client
COPY server ./server
COPY shared ./shared
# The build needs dev dependencies; they are removed before the copy below.
RUN npm run build && npm prune --omit=dev
FROM node:26-alpine
# The date keys the build cache so this layer installs today's OS fixes; AppJet keeps it current on deploy.
RUN echo "os-refresh 2026-11-19" && apk upgrade --no-cache
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# IMPORTANT: your server MUST listen on 0.0.0.0 and process.env.PORT.
RUN mkdir -p /app/data /home/appjet && chown -R 10001:10001 /app /home/appjet
ENV HOME=/home/appjet
USER 10001:10001
CMD ["npm","start"]
