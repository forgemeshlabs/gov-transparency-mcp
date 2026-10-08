FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js x402-guard.js README.md LICENSE glama.json ./
RUN chmod +x /app/index.js

ENV NODE_ENV=production

USER node

CMD ["node", "index.js"]
