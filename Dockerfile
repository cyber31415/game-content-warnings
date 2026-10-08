# EBS container for any HTTPS host (Render, Fly.io, a VPS behind Caddy...).
FROM docker.io/library/node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8081 DATABASE_PATH=/data/cache.sqlite
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-fund --no-audit
COPY ebs/src ebs/src
COPY shared shared
# The app runs as the unprivileged "node" user, which must own the cache directory.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8081
USER node
CMD ["node", "ebs/src/server.ts"]
