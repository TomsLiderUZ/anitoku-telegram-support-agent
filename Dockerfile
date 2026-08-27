FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Tashkent

COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

# Persist the database, Telegram session and generated skills outside the image.
VOLUME ["/app/data"]

EXPOSE 8787
ENV ADMIN_HOST=0.0.0.0

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD node scripts/health.js || exit 1

CMD ["node", "src/index.js"]
