# BookWise — interview Q&A

Questions an interviewer is likely to ask about this project, with answers that
point at the actual code. Grows as features land.

---

## Platform foundation

### "Walk me through how a service starts up."
[services/order-service/src/index.ts](../services/order-service/src/index.ts)
1. **Config is validated** with zod ([common/src/config.ts](../packages/common/src/config.ts)). A missing
   or malformed variable (e.g. a `JWT_SECRET` under 32 chars) stops the process
   immediately with a list of every problem. Failing at boot is far cheaper than
   failing on the first real request at 2 a.m.
2. **A Postgres pool** is created ([common/src/db.ts](../packages/common/src/db.ts)) with a
   `statement_timeout`, so no query can hold a connection and its row locks forever.
3. **Migrations run** (see below).
4. **The Fastify app** is built ([common/src/server.ts](../packages/common/src/server.ts)): structured
   logger, request-id propagation, a uniform error handler, and health probes.
5. **SIGTERM/SIGINT handlers** are registered, then the server listens.

### "How do you run DB migrations safely when two replicas start at once?"
[common/src/migrate.ts](../packages/common/src/migrate.ts) is a small forward-only runner:
- **Postgres advisory lock** (`pg_advisory_lock`). Only one replica migrates and
  the others wait. When the lock is released they see nothing is pending.
- **One transaction per file**, together with its row in `schema_migrations`. A
  migration is either fully applied *and* recorded, or not at all. Postgres has
  transactional DDL, so a failed `CREATE TABLE` rolls back cleanly.
- **Checksums.** Editing a file that has already been applied is refused. Schema
  history is append-only, so you write a new migration instead.
- In production you would usually run migrations as a separate deploy step (CI job
  or Kubernetes init container), not in every replica. `npm run migrate` exists for
  exactly that. For zero-downtime changes, use *expand → migrate code → contract*
  (add the new column, deploy code using both, backfill, then drop the old one).

### "Liveness vs readiness — what's the difference?"
[common/src/health.ts](../packages/common/src/health.ts)
- `/health/live`: *is the process alive?* If it fails, restart the container.
- `/health/ready`: *can it serve traffic right now?* It checks Postgres with a
  timeout. If it fails, the load balancer or orchestrator stops sending traffic.
  Restarting wouldn't help when the database is the thing that's down.
- Compose uses readiness in `healthcheck`, and `depends_on: condition: service_healthy`
  orders startup (DB healthy → service healthy → gateway).

### "What happens when you `docker stop` a service?"
Docker sends **SIGTERM** and waits (10 s by default) before SIGKILL.
[`startServer`](../packages/common/src/server.ts) catches SIGTERM, then:
- `app.close()` stops accepting connections and lets in-flight requests finish.
  Fastify answers 503 to new requests while closing.
- `onClose` hooks run, which closes the DB pool.
- The process exits 0. A hard deadline forces exit if a request hangs.

`init: true` in compose runs **tini** as PID 1, so signals are forwarded and zombie
processes are reaped. Measured: shutdown completes in about 3 ms with exit code 0.
Without the handler Docker waits the full 10 s, then kills the process (exit 137)
and in-flight requests are dropped.

### "Why validate requests with a schema in every service, not just the gateway?"
TypeBox schemas on every route (e.g. [inventory-service/src/schemas.ts](../services/inventory-service/src/schemas.ts)):
- **Defence in depth.** Services shouldn't trust the network. Internal callers have bugs too.
- **Bad input becomes a 400, not a 500.** Before this change, `GET /movies/not-a-uuid`
  reached Postgres and crashed with `22P02 invalid input syntax for type uuid`.
- **One source of truth.** The same definition gives runtime validation (Ajv)
  *and* the TypeScript type of `request.body`, so they can't drift apart.
- **Response schemas whitelist fields.** The seat-map response no longer leaks
  `reserved_by_order`, which used to tell customers which order holds which seat.
  It also makes JSON serialisation faster.

### "How do your services report errors?"
[common/src/errors.ts](../packages/common/src/errors.ts) gives every service the same body:
`{ statusCode, error, code, message, details? }`.
- Expected errors are thrown as `AppError` (`notFound()`, `conflict()`, ...).
- Postgres constraint violations are mapped: unique → 409, foreign key → 422,
  check → 400, bad input → 400. Constraints in the DB are the last line of
  defence even if a code path forgets a check.
- Anything else is a bug: logged with its stack, returned to the client as a generic
  500 with no internals (a unit test asserts a connection string never leaks).

### "Why do you release the DB connection before calling other services?"
Originally `POST /orders` held a pooled connection *while* the saga made three
HTTP calls (and the saga itself borrowed a second one). With `max: 10` connections:
- Throughput was capped at roughly 10 ÷ saga latency. A slow payment service
  meant the pool emptied, and **every** request, including health checks, queued.
- Health checks failing → container marked unhealthy → restarted while serving
  traffic. That's a cascading failure caused by one slow dependency.

The rule: **never hold a DB connection (or a transaction and its locks) across a
network call.** Commit, release, then call. The next step goes further: the saga moves out
of the request entirely (202 Accepted + a background worker).

### "Why one Dockerfile for all services? What's in the final image?"
[Dockerfile](../Dockerfile) is multi-stage and parameterised by `--build-arg SERVICE`:
- **base**: only the `package.json` files, so the `npm ci` layer is cached until a
  dependency actually changes.
- **build**: full install, compile `common` + the service.
- **prod-deps**: `npm ci --omit=dev` for that one workspace.
- **runtime**: compiled JS + production deps only. No TypeScript, no source,
  runs as the unprivileged `node` user.

### "Tell me about a bug you hit."
1. **Healthchecks failing even though the service was up.** `wget http://localhost:3003`
   inside the Alpine container resolved `localhost` to IPv6 `::1`, while Node was
   listening on IPv4 `0.0.0.0`. Fix: probe `127.0.0.1`. Lesson: "it works on my
   machine" often hides DNS/IPv6 differences.
2. **A service that "type-checked" but had no type checking at all.**
   `order-service/tsconfig.json` was an empty file, so `tsc` had nothing to check,
   and `tsx` (dev runner) strips types without checking. Once fixed, the compiler
   found real `unknown`-typed responses being used unsafely. Lesson: run `tsc` in
   CI, not just the dev server.
3. **The gateway only worked on Windows.** It imported `./plugins/rateLimit`, but
   the file was `ratelimit.ts`. Windows filesystems are case-insensitive, Linux
   containers are not.

### "Why TypeScript 7 and Biome instead of ESLint?"
TypeScript 7 is the native (Go) compiler, about 10× faster. `typescript-eslint`
doesn't support it yet (it needs the old JS compiler API), so lint and format use
**Biome**: one fast tool replacing ESLint + Prettier, with no dependency on the
TS API. The trade-off is fewer type-aware lint rules, which `tsc --strict` plus
`noUncheckedIndexedAccess` largely cover.
