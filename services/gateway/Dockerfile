# ── Stage 1: Build ────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files first (Docker cache optimization)
COPY package*.json ./
RUN npm ci --only=production

# Copy source code
COPY tsconfig*.json ./
COPY src ./src

# Compile TypeScript → JavaScript
RUN npm run build

# ── Stage 2: Production Image ─────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Only copy what's needed to run
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./

EXPOSE 3000

CMD ["node", "dist/index.js"]
