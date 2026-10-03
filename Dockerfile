# syntax=docker/dockerfile:1
# One Dockerfile for every service in the monorepo:
#   docker build --build-arg SERVICE=order-service -t bookwise/order-service .
#
# Multi-stage so the final image contains only compiled JS + production
# dependencies: no TypeScript, no dev tools, no source.

ARG NODE_IMAGE=node:22-alpine

# ── base ───────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# Every workspace manifest is needed for `npm ci` to match the lockfile.
# Copied on their own so the install layer stays cached until a dependency changes.
COPY package.json package-lock.json ./
COPY packages/common/package.json packages/common/
COPY services/gateway/package.json services/gateway/
COPY services/order-service/package.json services/order-service/
COPY services/inventory-service/package.json services/inventory-service/
COPY services/payment-service/package.json services/payment-service/
COPY services/auth-service/package.json services/auth-service/

# ── build: full install, compile common + the selected service ─
FROM base AS build
ARG SERVICE
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/common packages/common
COPY services/${SERVICE} services/${SERVICE}
RUN npm run build -w packages/common && npm run build -w services/${SERVICE}
# Gather what the runtime needs (migrations are optional, e.g. the gateway has none)
RUN mkdir -p /out && cp -r services/${SERVICE}/package.json services/${SERVICE}/dist /out/ \
    && if [ -d services/${SERVICE}/migrations ]; then cp -r services/${SERVICE}/migrations /out/; fi

# ── prod-deps: production dependencies of this service only ───
FROM base AS prod-deps
ARG SERVICE
RUN npm ci --omit=dev --no-audit --no-fund --workspace services/${SERVICE}

# ── runtime ────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/common/package.json packages/common/
COPY --from=build /app/packages/common/dist packages/common/dist
COPY --from=build /out services/${SERVICE}
# Never run as root inside the container.
USER node
WORKDIR /app/services/${SERVICE}
# Exec form: node is PID 1's child (compose `init: true` adds tini as PID 1),
# so SIGTERM reaches our graceful-shutdown handler.
CMD ["node", "dist/index.js"]
