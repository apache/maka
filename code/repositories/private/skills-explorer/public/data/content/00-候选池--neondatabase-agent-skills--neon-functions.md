---
name: neon-functions
description: >-
  Long-running, serverless Node.js HTTP functions deployed onto your Neon
  branch, with DATABASE_URL injected automatically and compute that runs next
  to your data. Use when a user wants to host an API, an AI agent with long
  streaming responses, a WebSocket or server-sent-events (SSE) server, a
  webhook handler, a Discord bot, an MCP server, or any request/response
  workload that risks timing out on short, lambda-style serverless functions —
  and wants it to branch with their database. Also use for Function Triggers:
  a cron or an object-storage event that POSTs to a function. Triggers include
  "serverless function", "deploy an API", "long-running function",
  "streaming agent", "SSE server", "WebSocket server", "webhook handler",
  "MCP server", "cron", "function trigger", "scheduled function", "cron job",
  "object storage trigger", "on upload", "run code next to my database",
  "function that won't time out", "function logs", "Neon Functions",
  "Neon Compute", "DDoS protection", "rate limiting", and
  "production hardening".
metadata:
  parent: neon
  source: https://github.com/neondatabase/agent-skills/tree/main/skills/neon-functions
---

**FIRST**: Use the parent `neon` skill for a Neon overview, getting started with Neon, Neon development best practices, and more.

If the `neon` skill is not installed, fetch it from https://neon.com/docs/ai/skills/neon/SKILL.md or install it with:

```bash
neon skills -s neon -y
```

# Neon Functions

Currently available in `aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, and `aws-ap-southeast-1`.

Neon Functions are long-running Node.js HTTP handlers deployed onto a Neon branch. Each function gets a public HTTPS URL, runs in the same region as your database, and — if the branch has Postgres — gets `DATABASE_URL` injected automatically. You deploy and manage them through the same Neon CLI, `neon.ts`, and API you already use.

Use this skill to help the user define, run locally, deploy, and manage functions next to their database. Deliver a deployed function with its invocation URL, a working local `neon dev` loop, or a precise answer from the official Neon docs.

## When to Use

Reach for Neon Functions when the workload is a request/response handler that benefits from staying alive and staying close to the data:

- **Long-running request/response flows that outlast lambda-style limits.** Agents that make several LLM calls and tool invocations per request, or image/video generation, routinely blow past the ~10–60s execution caps and short streaming windows of traditional serverless functions. Neon Functions are long-running: the handler just needs to _start_ responding within 15 minutes, and an open stream stays alive as long as bytes keep flowing. That's enough headroom for real agent workloads.
- **Stateful streaming without bolting on Redis.** Because a function stays alive across a request, it can host an SSE endpoint or a WebSocket server and hold the connection open in-process — no external state store (Redis, etc.) needed just to keep a stream coherent. Module-scope state (a `pg` pool, an in-memory counter) persists across requests on the same isolate.
- **Compute that must sit next to Postgres.** The function runs in the same region as the branch's database, so there are no cross-region round trips on every query. `DATABASE_URL` is injected for you.
- **A backend that branches with your data.** Each branch runs its own version of the function at its own URL, against its own isolated database (and storage, and gateway) state. Preview deployments, CI, and dev environments each get a self-contained backend — deploying to a child never affects the parent.
- **Query Postgres from the Function (or an existing framework handler).** Prefer that over the Data API. Use the Data API when the application already uses PostgREST or Supabase-js database calls, or is migrating that client.
- **Webhooks, bots, and post-response work.** Webhook handlers that fan out into multiple DB writes, Discord/WebSocket bots, and fire-and-forget follow-ups via `waitUntil` (analytics, audit logs) all fit.
- **Recurring HTTP work.** A Function Trigger POSTs to the function on a cron (`type: "schedule"`) or when an object is created in Object Storage (`type: "storage_object_created"`). Same `fetch` handler, same 15-minute time-to-first-byte limit. See [Function Triggers](#function-triggers).

If the workload is a pure static site, or something that must run outside the supported regions (`aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, and `aws-ap-southeast-1`) today, this isn't the right tool yet (see [Timeouts and Runtime Limits](#timeouts-and-runtime-limits) and [Availability](#availability)).

## What It Does

- **Long-running & serverless** — Built for WebSocket servers (see [WebSocket Servers](#websocket-servers)), SSE endpoints (see [Server-Sent Events (SSE)](#server-sent-events-sse)), long agent HTTP streams, and APIs. Still scales to zero when idle.
- **Web-standard handler** — A function is any default export with a `fetch(request)` method returning a `Response` (Workers/WinterTC-compatible). A Hono app exports exactly that shape, so `export default app` just works. Runs on Node.js 24, so all Node APIs are available.
- **Close to your database** — Runs in the branch's region; `DATABASE_URL` injected automatically when the branch has Postgres.
- **Branchable** — Each branch runs its own function version at its own URL against its own isolated state.
- **Same CLI/API** — Deploy and manage via `neon`, `neon.ts`, or the Neon API.
- **Function Triggers** — Neon POSTs to the function on a cron or an object-storage upload. See [Function Triggers](#function-triggers).

## Availability

Check this precondition before setting anything up: Neon Functions is currently available in `aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, and `aws-ap-southeast-1`. Confirm the user's Neon project is in one of these regions.

## Architecture: Where Functions Fit

Neon (Functions included) is **backend primitives, not full-stack app hosting**. Host your app on **Vercel** (or Netlify, or another frontend/app host); Functions are the long-running, stateful slice of your backend that lives next to your data. They compose with that platform in two ways:

- **Add a Function to a full-stack app.** Your Next.js / TanStack Start app on Vercel (or Netlify) owns UI, auth (Managed Auth, Better Auth, Clerk, or another IdP), and talks directly to Lakebase Postgres and Object Storage. Add a Function as a Hono API layer for the web app and other clients, or for one job next to the data: Object Storage uploads, AI agents, Discord bots, WebSocket or SSE servers. (See [Functions as an Agent Backend](#functions-as-an-agent-backend-nextjs-and-similar-frameworks) for the client-direct pattern.)
- **Run the whole backend control plane on Functions.** Especially when the frontend is **client-only** — TanStack Router, React Router in client mode, and similar SPAs hosted on Vercel or Netlify — the client calls Functions **directly**. Build REST APIs and request/response agents, host **MCP servers**, and run anything stateful or that belongs close to Postgres and Object Storage.

Either way, authenticate by caller: JWT or API key for app and public HTTP (see the WARNING under [Functions as an Agent Backend](#functions-as-an-agent-backend-nextjs-and-similar-frameworks)); `parseTriggerDelivery` for Function Trigger routes; production hardening in [Production hardening](references/production-hardening.md). Because a Function is just your backend, you can **move pieces between your host and Neon** — relocate an agent or a stateful WebSocket server onto a Function when it needs more runtime, and back if needed.

Prefer a Function, or an existing framework handler, that queries Postgres. Use Data API when the application already uses PostgREST/Supabase-js database calls or is migrating that client.

## Production hardening

Before exposing production routes, read [Production hardening](references/production-hardening.md).

Pick by caller: trusted app server, Function Trigger, or public consumer. Keep long browser streams on the client-direct JWT path unless a verified streaming-compatible proxy is required. Authentication rejects application work; requests to the native URL still reach the Function.

## Setup

Functions are declared in `neon.ts` (see the `neon` skill for the branch-first workflow and `neon.ts` basics). Add `@neon/config` and declare functions under `functions`, keyed by **slug**:

```typescript
// neon.ts
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  functions: {
    todos: {
      // slug: ^[a-z0-9]{1,20}$ — lowercase letters/digits, no hyphens
      name: "todo api", // display label only
      source: "src/index.ts", // entry file, relative to neon.ts
    },
  },
});
```

The slug is the function's permanent identity (it appears in the invocation URL and CLI commands) and can't be changed after the first deploy. Use `name` for a human-readable label.

A minimal function — a Hono app that queries the branch's Postgres via the injected `DATABASE_URL`:

```typescript
// src/index.ts
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { parseEnv } from "@neon/env";
import { attachDatabasePool } from "@neon/functions";
import config from "../neon";
import { todos } from "./db/schema";

const env = parseEnv(config);
const pool = new Pool({ connectionString: env.postgres.databaseUrl, max: 5 });
attachDatabasePool(pool);
const db = drizzle(pool);

const app = new Hono();
app.get("/", (c) => c.text("Neon + Hono + Drizzle"));
app.post("/todos", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  const [row] = await db.insert(todos).values({ text }).returning();
  return c.json(row, 201);
});
app.get("/todos", async (c) => c.json(await db.select().from(todos)));

export default app;
```

Create the `pg` pool at module scope (reused across requests on the same isolate) and keep `max` small (e.g. 5), since each isolate keeps its own pool. Call `attachDatabasePool(pool)` so an idle disconnect is not an `uncaughtException` — see [Connecting to Postgres](#connecting-to-postgres).

`parseEnv(config)` requires _every_ variable the config implies. A function that only talks to Postgres over the pooled URL can scope it to just that key — `parseEnv` then validates and returns only what you asked for (the keys autocomplete from your `neon.ts`):

```typescript
const { postgres } = parseEnv(config, ["DATABASE_URL"]); // not the unpooled URL, auth, etc.
const pool = new Pool({ connectionString: postgres.databaseUrl, max: 5 });
attachDatabasePool(pool);
```

## Develop Locally and Deploy

```bash
neon dev      # serves every function in neon.ts with hot reload; injects DATABASE_URL & friends
neon deploy --env <file>   # preferred full deploy from neon.ts; --env is the file Function env is read from
```

Keep `.env` or `.env.local` up to date with every key under `functions.*.env`. `neon env pull` writes Neon-managed vars only; add Function secrets to that file, then pass it as `--env`. `neon deploy --env <file>` loads that file into `process.env` each time, then uploads those values. A missing value is `undefined` and `defineConfig` throws. Omit the key from `neon.ts` if you do not want to write it. Never coerce a missing `process.env` value to an empty string (that uploads `""` and deletes the live key). An empty assignment (`KEY=`) is also `""`. Use `process.env.X!` when TypeScript needs an assertion.

To deploy a single function without applying `neon.ts`: `neon functions deploy <slug> --src src/index.ts` (`--src` takes either the entry file or a directory containing `index.ts`, `index.mjs`, or `index.js`). That command's `--env` is `KEY=VALUE` (repeatable), not a file path. Use it for a targeted env update. Retrieve the public URL with `neon functions get <slug>` (the `invocation_url` field, of the form `https://<branch_id>-<slug>.compute.<cell>.us-east-2.aws.neon.tech`). Manage with `neon functions list|get|delete`.

When `neon checkout` _creates_ a new branch and a `neon.ts` is present, it applies the policy automatically. Pass `--env <file>` on that create so Function env that reads `process.env` resolves (`neon checkout feat --create --env .env.local`). Existing process env wins over the file. Checking out an existing branch never reconciles it — apply config changes with `neon deploy --env <file>` (add `--update-existing` only after reviewing those changes).

## Neon Infrastructure as Code (`neon.ts`)

The `functions` block from [Setup](#setup) is part of `neon.ts`, Neon's infrastructure-as-code file — one TypeScript file declares every function (its `source`, display `name`, and `env`) alongside any other branch services, in version control (see the `neon` skill for the full reference). Treat it like Terraform for your branch:

```bash
neon config status   # print the branch's live config (deployed functions)
neon config plan     # dry-run diff of what apply would change
neon config apply --env <file>  # bundle + deploy the declared functions  (neon deploy is an alias; pass --env when Function env reads process.env)
```

Functions are **branch-scoped**: each branch runs its own deployment at its own URL. When a `neon.ts` is present, `neon checkout` applies the policy as it _creates_ a branch. Pass `--env <file>` on that create when Function env reads `process.env`. Checking out an _existing_ branch doesn't redeploy — run `neon deploy --env <file>` to apply changes.

Per-branch deploy tuning (e.g. `runtime`) lives in the `branch` closure, keyed by slug, so it can vary by branch without changing which functions exist:

```typescript
export default defineConfig({
  functions: { todos: { name: "todo api", source: "src/index.ts" } },
  branch: (branch) => ({
    functions: { todos: { runtime: "nodejs24" } },
  }),
});
```

## Environment Variables

Neon injects branch-scoped connection strings and service URLs at runtime — you don't declare these or pass them at deploy time:

| Variable                | Notes                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `NEON_BRANCH`           | The branch **name** (e.g. `main`, `preview/foo`). Injected on every branch, including the default. |
| `DATABASE_URL`          | Pooled connection string. Use for most queries. Present only if the branch has Postgres.           |
| `DATABASE_URL_UNPOOLED` | Direct connection. Use for migrations, `LISTEN`/`NOTIFY`, multi-round-trip transactions.           |
| `NEON_AUTH_BASE_URL`    | Present when Neon Auth is enabled on the branch.                                                   |
| `NEON_AUTH_JWKS_URL`    | Present when Neon Auth is enabled on the branch. JWKS for verifying Managed Auth JWTs.             |
| `NEON_DATA_API_URL`     | Present when the Data API is enabled on the branch.                                                |

Object storage (`AWS_*`) and AI Gateway (`NEON_AI_GATEWAY_*`) vars are also injected when those services are declared — see the `neon-object-storage` and `neon-ai-gateway` skills.

`neon env pull` / `neon-env run` / `neon dev` emit `NEON_BRANCH` (and the connection strings) into your local dev environment too, so local runs mirror the deployed runtime.

**Your own secrets** are per-deployment. Preferred path: declare them in `neon.ts` and run `neon deploy --env <file>`. `<file>` is the gitignored file env pull already writes (`.env` if that file exists, otherwise `.env.local`). Env pull writes Neon-managed vars only; add Function secrets to that file. All declared Function env keys must be present. Omit a key from `neon.ts` if you do not want to write it. `undefined` means you asked to write the key and the value is missing (`defineConfig` throws). Never coerce a missing `process.env` value to an empty string: that uploads `""` and deletes the live key. An empty assignment in the file (`KEY=`) is also `""`. If TypeScript needs an assertion, use `process.env.X!` and make sure the file has the value:

```typescript
functions: {
  todos: {
    name: "todo api",
    source: "src/index.ts",
    env: { RESEND_API_KEY: process.env.RESEND_API_KEY! },
  },
}
```

`neon functions deploy --env KEY=VALUE` is the manual path (repeatable; `--env KEY=` deletes a key; unmentioned keys carry over). Use it for a targeted env update, not a full `neon.ts` apply.

Load Function secrets into the same file env pull wrote, then `neon deploy --env <file>`. Pull the branch's Neon-managed vars onto disk for local dev with `neon env pull` (`link`/`checkout` do this automatically; pass `--no-env-pull` to skip and use `neon-env run -- <cmd>` for runtime injection). Limits: ≤1,000 vars, ≤64 KiB total, and the `NEON_` prefix is reserved.

## Connecting to Postgres

When the branch has Postgres, Neon **injects the connection strings at runtime** — you don't declare them, pass them at deploy time, or hardcode anything. The two you'll use:

- `DATABASE_URL` — **pooled** connection string (routed through Neon's connection pooler). Use it for normal request/response query traffic. Kept un-prefixed because every Postgres ORM (Drizzle, Prisma, Knex, …) reads `DATABASE_URL` by default.
- `DATABASE_URL_UNPOOLED` — **direct** connection string to the same database. Use it for migrations, `LISTEN`/`NOTIFY`, and long multi-statement transactions.

**Use Drizzle (or another ORM) on top of node-postgres (`pg`)** for queries and schema management — not Neon's serverless driver. Functions are long-running and reuse an isolate across many requests, so a persistent `pg` pool is the right fit; the serverless driver's HTTP transport is meant for fully isolated, lambda-style runtimes.

Create the connection pool **once at module scope** and reuse it across requests — don't open a connection per request:

```typescript
import { attachDatabasePool } from "@neon/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);
const db = drizzle(pool);
```

node-postgres emits idle-client failures as `error` on the pool. With no listener that is an `uncaughtException` and Node exits the isolate. Call `attachDatabasePool(pool)` once after `new Pool`. Requires `@neon/functions` ≥ 0.8.0. Expected idle disconnects (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`, Postgres `57P01`, node-postgres's `Connection terminated unexpectedly`) are silent. Anything else is `console.error`, or `onUnexpectedError` if you pass it on the first call. The first call wins; a later call that passes `onUnexpectedError` is ignored and warns. This does not close the pool.

**Pooling is recommended because an isolate is reused across many requests** (and several requests can be in flight on the same isolate at once — see [Timeouts and Runtime Limits](#timeouts-and-runtime-limits)). A module-scope pool is opened once on cold start and then shared by every subsequent request that isolate serves, so you amortize connection setup instead of paying it on every request and you avoid exhausting Postgres connections under load.

Keep `max` small (e.g. `5`): each isolate keeps its own pool, so total connections to Postgres scale with the number of live isolates. You don't need to close the pool on shutdown — when the runtime evicts an isolate it sends `SIGINT`/`SIGTERM`, and Neon's pooler reclaims those connections for you, so an explicit drain handler is redundant.

> Reading `process.env.DATABASE_URL` directly works everywhere. The function in [Setup](#setup) instead uses `@neon/env`'s `parseEnv(config)` to read the same value in a typed, validated way — either is fine.

## Timeouts and Runtime Limits

Functions are long-running but **still serverless** — they are a request/response runtime, not a background job runner. The hard limits:

- **Time to first byte: 15 minutes.** Your handler must _begin_ returning a response within 15 minutes of receiving a request. Most handlers finish in seconds; the 15-minute ceiling exists so agent workloads like image/video generation have room.
- **Heartbeat: 15 minutes.** Open WebSocket/SSE connections stay alive as long as data flows. The timeout only fires when a connection goes silent — send at least one byte every 15 minutes to keep a quiet stream alive.
- **`waitUntil`: 15 minutes.** Work registered with `waitUntil` (from `@neon/functions`) keeps the invocation alive after the response is sent, up to 15 minutes — for cleanup like analytics writes and audit logs, **not** a background job runner. Off the Neon runtime (local `neon dev`, tests) it's a no-op: the promise still runs but isn't tracked.
- **Idle eviction.** With no active connections Neon shuts the function down; it may also evict/restart for operational reasons — e.g. maintenance, or moving the function to a different compute node (active functions can run for hours first). Treat eviction like a process restart — WebSocket/SSE clients must reconnect. Neon sends `SIGINT` before evicting, so a `process.on("SIGINT", ...)` handler lets you detect that the function is about to be evicted and run any last-minute cleanup. You don't need one just to close Postgres connections — Neon's pooler reclaims those on its own.
- **Runtime:** Node.js 24, memory fixed at 2048 MiB. Slugs must match `^[a-z0-9]{1,20}$`. **An isolate is reused across many requests** — multiple requests can be in flight on the same isolate at once (interleaved on Node's single-threaded event loop), and under load the runtime runs several isolates in parallel, each with its own copy of module state. State held in module scope is therefore per-isolate (shared by every request that isolate handles) and in-memory only — persist anything that must survive eviction in Postgres. This reuse is exactly why you create a connection pool once at module scope rather than per request (see [Connecting to Postgres](#connecting-to-postgres)).

## Functions as an Agent Backend (Next.js and Similar Frameworks)

A Neon Function is a great home for an AI agent precisely because it **doesn't time out** the way lambda-style serverless does (15-minute budget, see [Timeouts and Runtime Limits](#timeouts-and-runtime-limits)). Proxying that stream through a Next.js route handler, Remix/SvelteKit/Nuxt action, or similar hosted on Vercel, Netlify, and the like **cuts the stream when it exceeds that host's configured duration or transport limits**, even though the Function would keep going. Keep the client-direct JWT path below as the default. A streaming-compatible proxy (HTTP-triggered Cloudflare Worker, after you verify the stream) is the public-consumer exception in [Production hardening](references/production-hardening.md).

**Building the agent itself.** The [Vercel AI SDK](https://ai-sdk.dev) and [Mastra](https://mastra.ai) are the recommended ways to build the agent — point either at the Neon AI Gateway (see the `neon-ai-gateway` skill) for one credential across every model, with no extra provider keys. For a complete AI SDK agent running as a Function (streaming `toUIMessageStreamResponse`, multi-step tool calling next to Postgres, and persisting generated images to Object Storage), see [references/ai-sdk.md](https://neon.com/docs/ai/skills/neon-functions/references/ai-sdk.md); for the Mastra equivalent with built-in tracing, see [references/mastra-studio.md](https://neon.com/docs/ai/skills/neon-functions/references/mastra-studio.md).

**The fix: call the function directly from the client.** Don't route the long request through your app server.

```
Browser ──(Authorization: Bearer <JWT>)──▶  Neon Function (agent)   ✅ no host timeout
Browser ──▶ your app backend ──▶ Neon Function                       ❌ host cuts the stream
```

- Get a **short-lived bearer token** from the identity the app already uses. Do not switch Clerk, Better Auth, Auth.js, Supabase Auth, or Managed Auth in order to call a Function.
  - Managed Auth, default client (`createAuthClient` / Next wrapper): `authClient.token()`, then `data.token`. Verify with injected `NEON_AUTH_JWKS_URL` and issuer `new URL(process.env.NEON_AUTH_BASE_URL!).origin`.
  - Managed Auth with `SupabaseAuthAdapter()`: that client has no `.token()`. Use `getSession()`, then `data.session.access_token`. Same JWKS/issuer as above.
  - Existing Better Auth / Auth.js / other signer that already publishes JWKS: use that JWKS URL, issuer, and audience. Inspect the installed contract; cookie or database sessions are not a JWKS.
  - Cookie/database sessions only: mint a short token on the existing app backend (that call is fast and stays within host limits), then the browser calls the Function **directly** with `Authorization: Bearer`. The Function stream must not go through the app host.
- Hand the token to the client, e.g. with the Vercel AI SDK: `new DefaultChatTransport({ api: NEON_FUNCTION_URL, fetch })` where `fetch` attaches `Authorization: Bearer <token>`. Your app server is never in the path of the long stream.
- Add **CORS** so the browser can reach it (handle `OPTIONS`, set `Access-Control-Allow-Origin`/`-Headers`).

> [!WARNING]
> A Neon Function has a **public HTTPS URL — it is reachable by anyone.** A direct client→function call means there is no app backend in front of it to gate access, so **you must authenticate the function yourself.** Verify a JWT against the caller's JWKS, check a shared secret / API key, or reject the request. Never deploy an unauthenticated agent. Browser callers use short-lived user tokens. Server or proxy origin secrets (`X-Secret`) stay server-side; see [Production hardening](references/production-hardening.md).

```typescript
// src/index.ts — verify the caller before doing any work
import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL!));
const issuer = new URL(process.env.NEON_AUTH_BASE_URL!).origin;

export default {
  async fetch(request: Request) {
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(request) });

    const auth = request.headers.get("authorization");
    if (!auth?.toLowerCase().startsWith("bearer ")) {
      return new Response("Unauthorized", {
        status: 401,
        headers: cors(request),
      });
    }
    let userId: string;
    try {
      const { payload } = await jwtVerify(auth.slice(7), jwks, { issuer });
      if (!payload.sub) {
        return new Response("Unauthorized", {
          status: 401,
          headers: cors(request),
        });
      }
      userId = payload.sub;
    } catch {
      return new Response("Unauthorized", {
        status: 401,
        headers: cors(request),
      });
    }
    // Authorize resource access by userId, then run the agent scoped to that user.
    // ... return result.toUIMessageStreamResponse({ headers: cors(request) })
  },
};
```

That snippet is Managed Auth verification. Mint the bearer token with `.token()` (`data.token`) on the default client, or `getSession()` then `data.session.access_token` on `SupabaseAuthAdapter()`. For another identity, pass that app's JWKS URL and issuer through Function `env` (see [Environment Variables](#environment-variables)) and include `audience` only when that token contract requires it. https://neon.com/docs/compute/functions/authentication.md

A valid token is not permission to read another user's rows. Exercise two users: each can access their own data; cross-user access is denied. Repeat after restarting the Function against stored rows. A request-supplied owner id cannot grant access.

Persist anything you need to keep (generated images, history) in Postgres — module state doesn't survive eviction.

## WebSocket Servers

A WebSocket server is the canonical Functions workload: a long-running handler holds connections open in-process, with no external state store needed to keep a stream coherent. The connection stays alive as long as bytes flow (15-minute heartbeat, see [Timeouts](#timeouts-and-runtime-limits)).

**Upgrade from inside `fetch`.** Call `upgradeWebSocket(request)` from [`@neon/functions`](https://www.npmjs.com/package/@neon/functions) and return the response it gives you. Hono apps use the same primitive via `@neon/functions/hono` (see [Hono](#hono) below). There is one entrypoint and no WebSocket dependency to install:

```typescript
import { upgradeWebSocket } from "@neon/functions";

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    const { socket, response } = upgradeWebSocket(req);
    socket.addEventListener("message", (event) => socket.send(event.data));
    return response;
  },
};
```

`socket` is a standard [`WebSocket`](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket), so `addEventListener` and the `onopen`/`onmessage`/`onclose`/`onerror` properties both work. It is still `CONNECTING` when you get it — the runtime writes the `101` only once your handler returns `response`, and the socket opens then.

Three rules that matter:

- **Return `response` unchanged.** A `101` can't be built as a plain `Response` (the fetch spec caps constructed responses at 200–599), so the runtime hands back an object carrying the pending upgrade. `clone()`, or rebuilding it with `new Response(res.body, res)` as response-rewriting middleware does, discards the upgrade and fails the request.
- **Refuse a handshake by returning an ordinary `Response`.** Return a `401`, `403`, or `404` from `fetch`, before you upgrade, to gate a socket. A browser client can't read why a handshake was refused; it sees only a generic connection failure, not your status or body. Refuse to keep clients out, but send any detail the client needs over a separate authenticated request.
- **`binaryType` defaults to `"arraybuffer"`**, not the browser's `"blob"`. `event.data` is a `string` for text frames and an `ArrayBuffer` for binary ones, so branch on `typeof`.

**With auth.** Browsers can't set headers on a WebSocket, so authenticate with a `?token=` query param (verify it the same way as the [agent backend](#functions-as-an-agent-backend-nextjs-and-similar-frameworks): `jwtVerify` against your JWKS) and refuse before upgrading:

```typescript
// src/index.ts
import { upgradeWebSocket } from "@neon/functions";

const clients = new Set<WebSocket>();

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket endpoint — connect with ?token=<jwt>");
    }

    const url = new URL(request.url);
    const identity = await verifyToken(url.searchParams.get("token"));
    if (!identity) return new Response("unauthorized", { status: 401 });

    const { socket, response } = upgradeWebSocket(request);
    clients.add(socket);
    socket.addEventListener("close", () => clients.delete(socket));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      persist(identity.id, event.data); // fan out to every isolate — see below
    });
    return response;
  },
};
```

**Subprotocols.** Pass `{ protocol }` to select one the client offered; it is echoed in `Sec-WebSocket-Protocol` and exposed as `socket.protocol`. Selecting one the client did not offer throws a `TypeError`. Omit it and no protocol is negotiated. No extensions are negotiated either — `socket.extensions` is always `""` and `permessage-deflate` is not available.

**Hono.** Use `upgradeWebSocket` from `@neon/functions/hono` — the same primitive as Hono's own WebSocket helper, with no `ws` dependency and not the deprecated `@hono/node-ws`. Auth is ordinary middleware; gate upgrade requests before `next()`:

```typescript
// src/index.ts
import { Hono } from "hono";
import { upgradeWebSocket } from "@neon/functions/hono";

const clients = new Set<WebSocket>();

const app = new Hono<{ Variables: { userId: string } }>();

app.use("/ws", async (c, next) => {
  const identity = await verifyToken(c.req.query("token"));
  if (!identity) return c.text("Unauthorized", 401);
  c.set("userId", identity.id);
  await next();
});

app.get(
  "/ws",
  upgradeWebSocket((c) => ({
    onOpen(_event, ws) {
      clients.add(ws.raw);
      ws.send("welcome");
    },
    onClose(_event, ws) {
      clients.delete(ws.raw);
    },
    onMessage(event, ws) {
      ws.send(`echo: ${event.data}`);
    },
  })),
);

export default app;
```

Connect from the browser with the function's `wss://` URL (from `neon functions get <slug>`), for example `new WebSocket("wss://<branch>-<slug>.compute.<region>.aws.neon.tech/ws?token=<jwt>")`. Reconnect on close — isolates are evictable and idle connections may be terminated after 15 minutes.

Do not put `cors()` on the upgrade route, and do not read `c.res` before `await next()` or call `c.header()` after it — both rebuild the `101` and break the upgrade. See `@neon/functions` README for the full middleware table.

### Heartbeat (keep the socket alive)

A connection stays open **only while bytes flow**: Neon evicts a silent stream after 15 minutes ([Timeouts and Runtime Limits](#timeouts-and-runtime-limits)), and intermediary proxies / load balancers are usually far stricter (often tens of seconds). Don't rely on the app being chatty enough — send a periodic keepalive from the server so the socket never goes quiet.

The standard `WebSocket` interface has no `ping()`, so send an application-level message the client filters out:

```typescript
const HEARTBEAT_MS = 25_000; // comfortably under proxy idle timeouts

const beat = setInterval(() => {
  for (const socket of clients) {
    if (socket.readyState === socket.OPEN) socket.send('{"type":"ping"}');
  }
}, HEARTBEAT_MS);
beat.unref?.();
```

The client skips these when handling messages. There is no protocol-level shortcut here: the standard `WebSocket` from `upgradeWebSocket` has no `ping()`, and a browser can't send ping frames from JavaScript, so an application-level message is the only keepalive a browser client can use. (A Node `ws` client can send ping frames, and the server auto-replies with a pong, but a browser can't.)

### Keeping clients in sync across isolates (do not skip this)

Under load the runtime runs **several isolates in parallel, each with its own copy of module state** — so each isolate has its own `clients` set. Broadcasting only to that local set means a client on isolate A never sees an event produced on isolate B, and the feed silently fractures. It's easy to miss: `neon dev` runs a single process (one isolate), so in-process broadcast always _looks_ fine locally but breaks in production, where concurrent connections spread across many isolates.

Module state doesn't survive eviction anyway, so **Postgres is the shared source of truth**. Pick a fan-out strategy. In every snippet below, `pool` is a pooled `pg` client and `clients` is this isolate's `Set` of live connections.

**1. Poll Postgres — the default, and the only option that keeps Scale to Zero.** Each isolate re-reads the shared state (or rows past a cursor) on a short interval and pushes changes to its own clients. One query per isolate per tick (not per client), and none when the isolate has no clients — so an idle compute still suspends.

```typescript
let lastId = "0"; // bigint id, so a string
let polling = false;

async function poll() {
  if (polling || clients.size === 0) return; // guard overlap; no clients → no query → compute can scale to zero
  polling = true;
  try {
    const { rows } = await pool.query("SELECT id, payload FROM events WHERE id > $1 ORDER BY id", [
      lastId,
    ]);
    for (const { id, payload } of rows) {
      lastId = id;
      for (const socket of clients) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    }
  } catch (err) {
    console.error("[poll]", err);
  } finally {
    polling = false;
  }
}

// Seed from the latest id so a fresh isolate sends only new rows, not the whole table, then poll.
pool
  .query("SELECT coalesce(max(id), 0)::text AS id FROM events")
  .then((seed) => {
    lastId = seed.rows[0].id;
  })
  .catch((err) => console.error("[seed]", err))
  .finally(() => setInterval(poll, 1000).unref?.());
```

- **Latency:** up to the interval (~1s) — fine for counters, chat, and dashboards.
- **Scaling:** database load grows with the number of live isolates, not clients. Keep the cursor on an indexed `serial`/`bigserial` PK and the interval sane.
- **Scale to Zero:** ✅ preserved — polling stops when no clients are connected, so the compute suspends on its normal timer.
- **Ordering:** `WHERE id > cursor` can skip a row that commits out of sequence: a transaction that took a lower id but commits after a higher one is already behind the cursor, so the poll never returns it. For a broadcast feed occasional loss is usually fine; when you need every row, use `LISTEN`/`NOTIFY` or poll by `created_at` with a small overlap window and dedupe by id.

**2. `LISTEN`/`NOTIFY` — lowest latency, but requires disabling Scale to Zero.** Each isolate `LISTEN`s on a channel over a dedicated **unpooled** connection; broadcasting is `NOTIFY`, so every isolate (including the sender's) re-pushes to its sockets. Near-instant — but the listener holds an idle connection that **does not count as active**, so [Scale to Zero](https://neon.com/docs/introduction/scale-to-zero) suspends the compute and drops it, silently killing the feed. Only use it on an **always-on** compute (Scale to Zero disabled — a paid-plan setting).

```typescript
import { attachDatabasePool } from "@neon/functions";
import { Pool, Client } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);
const CHANNEL = "chat_events";

// One dedicated DIRECT connection per isolate, just to receive events.
// Use DATABASE_URL_UNPOOLED — LISTEN needs a real session, not a pooled one.
// Don't call attachDatabasePool here: it would silence the idle drop that killed the feed.
// The error listener keeps the process alive; reconnect the client on error in production (omitted here).
const listener = new Client({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
});
listener.on("error", (err) => {
  console.error(err);
});
listener.connect().then(() => listener.query(`LISTEN ${CHANNEL}`));
listener.on("notification", (msg) => {
  if (!msg.payload) return;
  for (const socket of clients) {
    if (socket.readyState === socket.OPEN) socket.send(msg.payload);
  }
});

// Broadcast by NOTIFYing through the pool — every isolate's listener fires.
function broadcast(event: unknown) {
  return pool.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(event)]);
}
```

**3. External pub/sub (e.g. [Upstash](https://upstash.com) Redis) — best at scale.** For high fan-out, sub-second latency at large connection counts, or multi-region, publish/subscribe through a dedicated broker. Highest throughput, and it doesn't touch Postgres or block Scale to Zero — at the cost of another service to run.

**Rule of thumb:** start with **polling** (works with Scale to Zero, no extra infra); switch to `LISTEN`/`NOTIFY` only on always-on compute that needs sub-second latency; move to Redis when fan-out outgrows Postgres.

### Client must reconnect

Idle functions are evicted (and isolates restart for operational reasons), so a client's socket **will** drop — treat reconnection as normal, not exceptional. Reconnect with exponential backoff, capped, and **re-mint a fresh token on every attempt** (tokens are short-lived, so a stale one fails the `upgrade` auth check):

```typescript
let closed = false,
  retry = 0,
  timer: ReturnType<typeof setTimeout>;

async function connect() {
  if (closed) return;
  const token = await getToken(); // re-mint each attempt; short-lived
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    retry = 0; // reset backoff on success
  };
  ws.onmessage = (e) => {
    /* apply the event */
  };
  ws.onclose = () => {
    if (!closed) timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
  };
  ws.onerror = () => ws.close(); // let onclose drive the retry
}
connect();
```

Together — `upgradeWebSocket` inside `fetch`, JWT auth over `?token=`, cross-isolate fan-out, and client backoff — these compose into a complete realtime chat backend on a single function.

## Server-Sent Events (SSE)

When you only need **server → client** streaming (live counters, notifications, progress, token streams), SSE is simpler than a WebSocket and needs no upgrade at all: a plain `fetch` handler returns a `Response` whose body is a `ReadableStream` with `Content-Type: text/event-stream`, and the runtime holds it open as long as bytes flow. The browser consumes it with `EventSource`, which **reconnects on its own** — so there's no client backoff to write.

```typescript
// src/index.ts — minimal SSE endpoint
const encoder = new TextEncoder();
export default {
  fetch: () => {
    let t: ReturnType<typeof setInterval>;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: hello\n\n"));
          t = setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 25_000);
        },
        cancel() {
          clearInterval(t); // fires when the client disconnects
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
        },
      },
    );
  },
};
```

The same rules as WebSockets apply. **Heartbeat:** a stream stays open only while bytes flow — Neon's window is 15 minutes ([Timeouts and Runtime Limits](#timeouts-and-runtime-limits)) but proxies are usually far stricter, so emit a `: ping\n\n` comment every ~25–30s (shown above) to keep idle streams from being dropped. Keep state in Postgres, and fan out across isolates using one of the [sync strategies](#keeping-clients-in-sync-across-isolates-do-not-skip-this) (hold a `Set` of stream controllers and `enqueue` to each). `EventSource` is GET-only and can't set headers, so authenticate with a `?token=` query param or cookie, exactly like the WebSocket case. [references/sse.md](https://neon.com/docs/ai/skills/neon-functions/references/sse.md) has the full pattern — Hono variant, cross-isolate fan-out, wire format, client, and caveats.

## Function Triggers

A Function Trigger POSTs JSON to your function on a cron (`schedule`) or when an object is created in Object Storage (`storage_object_created`). Declare it in `neon.ts`, apply with `neon deploy`, and authenticate the delivery with `parseTriggerDelivery` (`@neon/functions/triggers`). `parseTrigger` (Hono) and `parseTriggerInvocation` stay schedule-only. Prefer `neon.ts`; CLI and the Neon MCP trigger tools (`list_triggers`, `create_trigger`, …) are the backup.

Trigger routes must not require a user JWT or `X-Secret`; Neon POSTs to the native URL without those. Production caller shapes: [references/production-hardening.md](references/production-hardening.md). Full field list, CLI, MCP, payload, inheritance, and both handler shapes: [references/function-triggers.md](references/function-triggers.md).

## MCP Servers

An [MCP](https://modelcontextprotocol.io) server is a natural Functions workload: a long-running HTTP handler that exposes tools to AI clients (Cursor, Claude, ChatGPT, agents), with those tools reading and writing the branch's Postgres right next to the compute. MCP's **streamable HTTP transport** is a plain `POST`/`GET` on a single endpoint (conventionally `/mcp`), so it maps onto a function's `fetch` handler with no `upgrade` method or extra protocol.

The simplest host is a Hono app using the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) plus [`@hono/mcp`](https://github.com/honojs/middleware/tree/main/packages/mcp), which bridges the transport to a route. Build the server, register its tools, and create the transport once at module scope, then hand every `/mcp` request to it:

```typescript
const transport = new StreamableHTTPTransport();
app.all("/mcp", async (c) => {
  if (!mcpServer.isConnected()) await mcpServer.connect(transport);
  return transport.handleRequest(c);
});
```

Because the function's URL is public, **authenticate before connecting the transport** — [Better Auth](https://better-auth.com) covers both OAuth (its MCP plugin makes your app the authorization server so third-party clients self-authorize per the MCP spec) and a simpler API-key / session-JWT check for your own callers. Public-consumer edge protection: [references/production-hardening.md](references/production-hardening.md). [references/mcp.md](https://neon.com/docs/ai/skills/neon-functions/references/mcp.md) has the full pattern — server with Postgres-backed tools via Drizzle, both Better Auth auth options, and testing with `mcporter` / `add-mcp`.

## Integrations and Observability

### Built-in branch logs

```bash
neon logs query --branch production --source function --since 1h
```

Functions is one of the two sources branch logs cover today, alongside Object Storage. Logs are scoped to a single branch, so pass `--branch` when the deployed function isn't on the branch you're checked out on. Everything else about logs — the required CLI version, filters, the SDK, and the Loki-compatible read API — is in the parent `neon` skill's **Observability** section.

### Application instrumentation

A function is a long-lived Node.js process running a web-standard request/response handler, so standard Node integration SDKs work unchanged. Initialize them once at module load, gated on an env var so local dev and unconfigured branches stay a no-op, and pass secrets via `--env` or `neon.ts` `env`.

- **Sentry** — error monitoring across the HTTP framework, the function runtime, and an agent's own caught/fallback failures (the long-running case Functions target): see [references/sentry.md](https://neon.com/docs/ai/skills/neon-functions/references/sentry.md).
- **Mastra Studio (Mastra Cloud)** — run a Mastra agent on a function and ship its traces to a Studio project for observability: see [references/mastra-studio.md](https://neon.com/docs/ai/skills/neon-functions/references/mastra-studio.md).

## Neon Documentation

The Neon documentation is the source of truth and Functions is evolving rapidly, so always verify against the official docs. Any doc page can be fetched as markdown by appending `.md` to the URL or by requesting `Accept: text/markdown`. Find the right page from the docs index (https://neon.com/docs/llms.txt) and the changelog announcements.

## Further Reading

- https://neon.com/docs/compute/functions/overview.md
- https://neon.com/docs/compute/functions/get-started.md
- https://neon.com/docs/compute/functions/deploy.md
- https://neon.com/docs/compute/functions/environment-variables.md
- https://neon.com/docs/compute/functions/reference/neon-ts.md
- https://neon.com/docs/compute/functions/reference/runtime-limits.md
- https://neon.com/docs/compute/functions/authentication.md
- https://neon.com/docs/compute/functions/custom-domains.md
- https://neon.com/docs/cli/triggers.md
- [references/function-triggers.md](references/function-triggers.md)
- [references/production-hardening.md](references/production-hardening.md)
