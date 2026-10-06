# Image Flattener, self-hosted: the web app plus a small server that stores
# projects in /data and relays read-only requests to Spoolman.

# The build output is plain static files, so build once on the native platform.
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# (npm can exit 0 after a failed install; make sure the tools are there)
RUN npm ci && npx --no-install tsc --version
COPY . .
RUN npm run typecheck && npm test && npm run build:server

FROM node:20-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/server.mjs ./server/server.mjs
COPY package.json ./
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
CMD ["node", "server/server.mjs"]
