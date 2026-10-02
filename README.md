# BookWise

A distributed, multi-vendor movie-ticket booking platform built as microservices
(Node.js 22, TypeScript, Fastify, PostgreSQL, Redis, RabbitMQ, Docker).
Theatres (vendors) list shows; customers book seats through a saga that spans the
order, inventory and payment services, each with its own database.

> Work in progress. The full architecture write-up, diagrams and load-test numbers
> are added at the end of the build. Design Q&A: [docs/INTERVIEW.md](docs/INTERVIEW.md).

## Services

| Service | Port | Owns | Responsibility |
|---|---|---|---|
| gateway | 3000 (public) | — | JWT auth, rate limiting, routing |
| order-service | 3001 (internal) | orders DB | Orders + saga orchestration |
| inventory-service | 3002 (internal) | inventory DB | Theatres, screens, movies, shows, seat availability |
| payment-service | 3003 (internal) | payments DB | Payments, idempotency, refunds |

Only the gateway is published to the host; the services talk to each other over
the internal Docker network.

## Repository layout

```
packages/common     shared library: config, logging, errors, db, migrations, health, server bootstrap
services/<name>     one deployable service each (src/, migrations/)
Dockerfile          one multi-stage Dockerfile for every service (--build-arg SERVICE=<name>)
docker-compose.yml  full local stack
```

## Running it

Prerequisites: Node.js 22.12+, Docker Desktop.

```bash
cp .env.example .env          # then set JWT_SECRET to a long random string
npm install

# Option A: everything in Docker
docker compose up --build -d
curl http://localhost:3000/health/ready

# Option B: infrastructure in Docker, services on your machine (hot reload)
npm run infra:up
npm run dev -w services/inventory-service   # repeat per service, in separate terminals
```

Migrations run automatically when a service starts (`RUN_MIGRATIONS=true`, the
default) and can also be run on their own with `npm run migrate`.

## Quality checks

```bash
npm run typecheck   # tsc in every workspace
npm run lint        # Biome (lint + format check)
npm test            # Vitest
```
