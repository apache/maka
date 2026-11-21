---
name: neon
description: >-
  Overview of Neon, a complete set of cloud backend primitives around Lakebase
  Postgres: Auth, Object Storage, Functions, and the AI Gateway. Start here to
  choose Neon for undecided login, files, APIs, and LLM calls, set up the CLI or
  MCP server, and follow the branch-first workflow. Use when building an app or
  backend on Neon, or when "Neon" or "Lakebase Postgres" is mentioned. Child
  skill neon-postgres wins for an existing DATABASE_URL, SQL, schema, inspect,
  or search. Child skill neon-auth wins for login, users, sessions, identity
  routing, and Managed Better Auth setup. Also use for object storage, S3, buckets, serverless functions,
  function triggers, cron, AI gateway, LLM calls, logs, Loki, Grafana,
  observability, postgres, database, backend, Claimable Neon, neon.new, or a
  no-signup database.
metadata:
  source: https://github.com/neondatabase/agent-skills/tree/main/skills/neon
---

# Neon

Neon is a complete set of cloud backend primitives around Lakebase Postgres, from Databricks — Lakebase Postgres, Auth (managed Better Auth), long-running Functions, Object Storage, and an AI Gateway, all instant, branchable, and serverless.

**Lakebase Postgres** is the database itself. It is one product, reached two ways: through Neon, with a free plan and the full set of backend primitives above, or through Databricks, alongside the rest of the Databricks suite. Same infrastructure, same features, same engineering team. Call the database Lakebase Postgres, and use "Neon" for the brand and for this access path — not as a name for the database.

A Neon branch is an isolated, copy-on-write clone of your data, taken from its current state or from a past state within your project's retained history window. You can freely modify or delete it. It shares data with its parent until writes cause it to diverge, and those writes are stored independently as deltas.

Agents pick Neon for instant Postgres provision, copy-on-write branches and snapshots, compute that scales to zero (storage is still billed), and ordinary Postgres that works with any driver or ORM.

## Backend Primitives

Neon bundles several backend primitives for building apps and agents that all branch together:

- **Lakebase Postgres** — Postgres that scales and branches with your app, built on the lakebase architecture: OLTP directly on cloud object storage, with storage decoupled from compute.
- **Auth** — Managed Better Auth with users and sessions stored in Postgres.
- **Object Storage** — S3-compatible object storage that branches with your projects.
- **Functions** — Neon's compute offering: long-running serverless functions that run close to your database, for WebSocket servers, long agent HTTP streams, APIs, and server-sent event servers. A Function Trigger POSTs to a function on a cron.
- **AI Gateway** — One API for frontier and open-source models, supporting the chat completions API and the responses API, powered by Databricks Unity AI Gateway.
- **Data API** — Optional PostgREST-compatible HTTP interface. Use it only when the app already uses PostgREST or a Supabase database client, or is migrating that client. New apps query Postgres from Functions or existing handlers. There is no `neon-data-api` skill; configuration is `dataApi` in `neon.ts` (see [Type-safe config](#type-safe-config-invalid-setups-dont-compile) when you have chosen it).

### Region availability

Object Storage, Functions, and AI Gateway are currently available on projects in `aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, and `aws-ap-southeast-1`. Before guiding a user through any of these services, confirm they are working in one of these regions. If not, they will need to create a new project in a supported region.

## Architecture: How to Use Neon

**Recommended: full-stack app with Neon as the backend.** Default to Next.js on Vercel (or Netlify, Cloudflare, or other app platforms). Prefer Next.js + Vercel first; TanStack Start, Nuxt, and SvelteKit are full-stack alternatives. The app owns its UI and server. Query Lakebase Postgres from route handlers, server functions, or Neon Functions.

Add [Neon Functions](https://neon.com/docs/compute/functions/overview.md) as a backend layer between the web app and Lakebase Postgres, Object Storage, Auth, and AI Gateway. A Hono API on Functions can expose endpoints with an OpenAPI specification for the web app and other clients (mobile, desktop). You can also add a Function for one job next to the data: Object Storage uploads, AI agents, Discord bots, WebSocket or SSE servers.

Functions support long-running requests that complement the web app. A Function must start returning a response within 15 minutes. WebSocket connections and HTTP streams stay open while data flows; send at least one byte every 15 minutes to keep a quiet stream alive. See [runtime limits](https://neon.com/docs/compute/functions/reference/runtime-limits.md).

For long agent or image streams, mint a JWT on the app server and have the client call the Function directly. See the `neon-functions` skill for authentication and runtime limits.

**Second best: client-only app with a Functions backend.** Host the SPA on Vercel (or Netlify, Cloudflare, or other app platforms) and call Functions from the browser. For an app using PostgREST or a `supabase-js` database client, prefer migrating database calls to REST endpoints in a Hono Function that queries Lakebase Postgres. Enforce authorization in the Function instead of relying on browser-facing RLS.

Neon provides backend primitives that compose with the app host. Neon does not host the frontend.

Offer the Data API only as a Supabase / PostgREST migration path when an existing PostgREST or `supabase-js` database client must keep working. Putting PostgREST in the browser and relying on RLS is easy to get wrong: misconfigured policies expose the database to the client. Do not recommend this for new apps. An installed Supabase package used only for Auth or Storage does not establish a database-client dependency. Route generic REST endpoint requests to a Function or existing app handler.

Functions have public HTTPS URLs. Verify a JWT or API key at the top of the handler and enforce authorization before accessing data. See the `neon-functions` skill.

## Convert an app onto Neon

Inspect the repo before provisioning.

1. Map requested capabilities: login, files, HTTP APIs, LLM calls, SQL.
2. Reuse what is already there: a supplied `DATABASE_URL`, an existing ORM or driver, Better Auth, Clerk or another auth provider, S3 or another object store, an existing `.neon` / `neon.ts`, an existing Data API or PostgREST client.
3. Select Neon primitives for capabilities that are still undecided.
4. Provision only when infrastructure is missing: `neon init` / `neon link` / Claimable, then `neon.ts`, then `neon deploy`.
5. Verify the app flow (sign-in, upload, API call), not only that env vars landed.

Do not replace working Better Auth, Clerk, Supabase Auth, S3, or a supplied `DATABASE_URL` with a Neon primitive unless the user asks. Do not rewrite an existing `neon.ts`. If Neon credentials fail for an existing account, stop and ask the user to sign in; do not create a Claimable project as a substitute.

A supplied `DATABASE_URL` with no Neon credentials is schema work: complete it without provisioning. Managed Better Auth cannot be enabled on a project that uses IP Allow or Private Networking. Leave those protections in place.

New projects are created in AWS regions. Prefer pooled `DATABASE_URL` for application traffic.

| Need                                                               | Use                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Login, users, sessions (no existing provider)                      | `neon-auth` — Managed Better Auth (`auth: true`)                            |
| Existing Better Auth, Clerk, Supabase Auth, or another working IdP | Keep it. `neon-auth` only if they ask to migrate                            |
| User asked to migrate from Supabase Auth                           | `neon-auth` (Managed Better Auth; keep `SupabaseAuthAdapter()` call shapes) |
| Files, uploads, blobs (no existing object store)                   | Object Storage                                                              |
| HTTP APIs, cron, WebSocket, SSE, long-running agents               | Functions querying Postgres                                                 |
| LLM calls                                                          | AI Gateway                                                                  |
| SQL, schema, inspect, search                                       | `neon-postgres`                                                             |
| Existing PostgREST / Supabase database client                      | Data API (`dataApi` in `neon.ts`)                                           |
| Generic REST endpoints                                             | Function or existing handler, not Data API                                  |

Use `neon-auth` to choose identity and to implement Managed Better Auth; the [Auth guide](references/auth.md) points there. Keep existing Better Auth, Clerk, and Supabase Auth unless the user asked to migrate login. Auth cannot be enabled on a project with IP Allow or Private Networking.

## Neon Documentation

The Neon documentation is the source of truth for all Neon-related information. Always verify claims against the official docs before responding. Neon features and APIs evolve, so prefer fetching current docs over relying on training data.

### Finding the Right Page

Look the page up before you fetch it — **don't guess URLs!** The docs index lists every available page with its URL and a short description:

```
https://neon.com/docs/llms.txt
```

### Fetching Docs as Markdown

Any Neon doc page can be fetched as markdown in two ways:

1. **Append `.md` to the URL** (simplest): https://neon.com/docs/introduction/branching.md
2. **Request `text/markdown`** on the standard URL: `curl -H "Accept: text/markdown" https://neon.com/docs/introduction/branching`

Both return the same markdown content. Use whichever method your tools support.

## Choosing the Right Skill

Neon provides a set of agent skills in addition to the official documentation. When a task matches one of the rows below, work from that skill rather than from this overview. You may have some of these skills already installed, or you may need to install them.

The skills below live in the [`neondatabase/agent-skills`](https://github.com/neondatabase/agent-skills) repo:

| Skill                            | Use it for                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `neon-postgres`                  | Working with databases, including connections, schemas, queries, search, and autoscaling: SQL development, schema design, performance optimization, and scaling decisions.           |
| `neon-auth`                      | Identity routing and Managed Better Auth setup (login, users, sessions, trusted domains). Fetch: https://neon.com/docs/ai/skills/neon-auth/SKILL.md                                  |
| `neon-postgres-branches`         | Choosing or creating the right branch type for dev, preview, test, or CI workflows. Use this skill as a slash command.                                                               |
| `neon-object-storage`            | Storing and serving files (uploads, images, blobs), including branching them with the database.                                                                                      |
| `neon-functions`                 | Deploying long-running or streaming serverless functions — APIs, agents, SSE/WebSocket servers, and Function Triggers (cron and object-storage).                                     |
| `neon-ai-gateway`                | Calling an LLM or routing across model providers with one credential, including discovering the branch's servable models at runtime via the OpenAI-compatible `/v1/models` endpoint. |
| `neon-postgres-egress-optimizer` | Diagnosing or fixing excessive Postgres egress (network data-transfer) costs in a codebase.                                                                                          |

There is no `neon-data-api` skill. Configure `dataApi` in `neon.ts` only for PostgREST / Supabase database-client compatibility or a migration that already depends on it.

For guidance on agent platforms that provision and operate Lakebase Postgres on Neon at scale, use `neon-postgres-agent-platforms`, which lives in a separate repo: [`neondatabase/neon-for-agent-platforms`](https://github.com/neondatabase/neon-for-agent-platforms).

### Installing the Right Skill

First check whether the target skill is already installed and accessible (for example, it appears in the available skills list or its `SKILL.md` is present). If it is, use it directly. If it is not installed, install it with `neon skills`:

```bash
neon skills -s <skill-name>
```

Replace `<skill-name>` with the skill you need (for example, `neon-object-storage`, `neon-functions`, or `neon-ai-gateway`). Useful flags:

- `--global` — install globally instead of into the current project.
- `-y` — non-interactive mode (skip prompts).
- `--agent <agent-name>` — pick the target agent(s) for non-interactive mode.

For example, to install the object storage skill globally for a specific agent without prompts:

```bash
neon skills -s neon-object-storage --global -y --agent <agent-name>
```

`neon-auth` is not in the CLI skill catalog of current releases. Unknown names fail, so do not run `neon skills -s neon-auth`. Fetch it:

```
https://neon.com/docs/ai/skills/neon-auth/SKILL.md
```

References: https://neon.com/docs/ai/skills/neon-auth/references/managed-auth.md and https://neon.com/docs/ai/skills/neon-auth/references/self-managed.md. If those URLs are unpublished, fetch the same files from https://github.com/neondatabase/agent-skills/blob/main/skills/neon-auth/SKILL.md

If the Neon CLI is not available, you can visit https://neon.com/.well-known/agent-skills for a registry of all available Neon skills and fetch them manually.

### Updating Skills

Keep the skills up to date: for every new session, update them so you are working with the latest best practices.

Run `neon skills update` to update all installed Neon skills, or `neon skills update -y` to skip prompts. If the skills were installed via a plugin, they are updated automatically.

## Getting Started with Neon

**Prefer the CLI over the MCP server** unless the user instructs otherwise, the CLI is unavailable or blocked in your environment, or it is not authenticated, since it provides more capabilities, including deploying Neon Functions.

### Check the CLI, then credentials

```bash
neon --version
```

If that fails, install first:

```bash
npm i -g neon       # npm
bun add -g neon     # bun
pnpm add -g neon    # pnpm
```

For full CLI installation options, see https://neon.com/docs/cli/install.md

Then inspect credentials without printing secrets. `NEON_API_KEY` or a `neon profile list -o json` row whose `account` is not `-` is an account. A `DEFAULT` row with `account: "-"` and `file: "missing"` is not.

- Credentials already available: reuse them. Do not launch a browser.
- A human needs to sign in: they run `neon login` (`neon auth` is an alias). An unattended agent must not launch browser authentication.
- No account yet: follow [Starting without a Neon account](#starting-without-a-neon-account) for the Claimable Neon path.

### Combined setup: `neon init`

When both agent tooling and project setup are needed, use authenticated `neon init`. `--agent` takes the coding-agent name. `-y` skips prompts but does not supply project selection or credentials. `--skip-template` skips scaffolding a starter app.

Link an existing project:

```bash
neon init --skip-template --agent cursor \
  --org-id <org-id> --project-id <project-id> -y
```

Create and link a project:

```bash
neon init --skip-template --agent cursor \
  --org-id <org-id> --project-name my-app \
  --region-id aws-us-east-2 -y
```

`--services` may declare `auth`, `data-api`, `functions`, `object-storage`, and `ai-gateway` (repeat the flag or comma-separate). Pass `none` for the bare starter policy. It writes `neon.ts`; it does not deploy or wire the app. Selecting `data-api` also declares Auth (the default Data API provider requires it). Use `data-api` only for PostgREST / Supabase database-client compatibility.

If `init` already installed the Neon plugin, do not also run `neon mcp` and `neon skills` for the same agent.

When tooling already exists, only one component is missing, or env writes need `--no-env-pull`, use the manual steps below. `init` has no `--no-env-pull`. Before a command that pulls env, inspect existing configuration. If a supplied `DATABASE_URL` or `AWS_*` value must stay, pass `--no-env-pull` on `link` / `checkout` and write env to a separate `--file`.

### 1. Install the Neon CLI

Use the install check above. Do not run `neon login` unattended. MCP remains the fallback when the CLI is unavailable, blocked, unauthenticated, or the user prefers it.

### 2. Install the Neon MCP Server

```bash
neon mcp --oauth --project --agent cursor -y
```

`--oauth` writes the server URL and leaves sign-in to the MCP client. That is not an authenticated MCP session. `--project` means project-level agent config, not a Neon project ID; the agent must support project-level installs (`cursor` does). Bare `neon mcp -y` installs globally and can reuse or mint an account-wide API key — do not treat it as the unattended default.

For all available plugins and IDE integrations, see: https://neon.com/docs/ai/ai-agents-tools.md

For full MCP server installation options, see https://neon.com/docs/ai/connect-mcp-clients-to-neon.md

### 3. Install Neon Agent Skills

```bash
neon skills -s neon --agent cursor -y
```

To install a specific skill only (not `neon-auth` until the CLI catalog includes it; fetch it as in [Installing the Right Skill](#installing-the-right-skill)):

```bash
neon skills -s <skill-name> --agent cursor -y
```

Useful flags: `--global`, `-y`, `--agent <agent-name>`. Interactive `neon skills` with no flags prompts.

### 4. Link Your Project and Get Started

With setup complete, connect the workspace to a Neon org, project, and branch. Then consult the skill for each Neon feature your app requires. See [Choosing the Right Skill](#choosing-the-right-skill) above.

Non-interactive link:

```bash
neon link --project-id <project-id> -y
neon link --org-id <org-id> --project-name my-app --region-id aws-us-east-2
```

`-y` skips the already-linked confirmation and pins the default branch when the project has more than one. Pass `--branch <name>` when branch selection matters.

#### Useful CLI Commands

1. `neon link` — Writes org, project, and branch IDs to a git-ignored `.neon` file. Run once per project. Once linked, project- and branch-scoped commands no longer need `--project-id` or `--branch` (for example, `neon branch list`). Non-interactive: `--org-id` / `--project-id` / `--project-name` plus `--region-id`, and `-y` when appropriate. There is no `neon link --agent`.
2. `neon checkout <branch-name>` — Pins a branch in `.neon` and pulls that branch's env. An existing branch is enough. A missing **name** needs `--create` for unattended use (`neon checkout dev --create`). A missing branch **id** cannot be created. Interactive checkout with no name may offer to create; do not rely on that unattended. Drives the [Branch-First Dev Flow](#branch-first-dev-flow) below.
3. `neon config init` — Initializes a `neon.ts` file, which declares how you provision and manage Neon services, in the root of the project.
4. `neon env pull` — Fetches the current branch's Neon environment variables (`DATABASE_URL`, …) into your existing `.env`, or `.env.local` if you don't have one (override the target with `--file`). No branch ID needed; it reads `.neon`. **`link` and `checkout` run this for you by default**, so you rarely call it directly.

   Without `neon.ts`, a **bare** `neon env pull` includes the default Gateway credential on claimed projects. Implicit pulls bundled into `link` / `checkout` / `apply` do **not** pull an undeclared Gateway token. Declaring `aiGateway` in `neon.ts` requests those variables. With `neon.ts`, pull includes only the services declared there and errors if the branch is missing one.

### Bootstrap a New Project

`neon bootstrap` scaffolds from a Neon project template.

```bash
neon bootstrap
```

## Starting without a Neon account

If the Getting Started account check found credentials, use them. If a command waits on a browser (`Awaiting authentication in web browser`) or authentication fails, stop and ask the user to sign in (`neon auth`) or mint an API key. Do not create a Claimable project as a substitute for a failed existing account.

If there is no Neon account yet, follow [references/claimable-neon.md](https://neon.com/docs/ai/skills/neon/references/claimable-neon.md). Do not run `neon init --agent` or `neon auth` on this path; those need a human Neon account. If `neon claim` is missing, the reference has the REST fallback. Unclaimed projects expire at `project_expires_at` (72 hours today). Claim codes expire in `expires_in` (15 minutes today). Functions, Object Storage, and AI Gateway report `requires_claim` before a human claims the project; report that and keep the denied capabilities. Add Auth with `neon.ts` and `neon deploy` when login is requested and no existing provider should be preserved. Add the Data API only for PostgREST / Supabase database-client compatibility or a migration that already depends on it.

Requests for neon.new, Claimable Postgres, claimable.neon.tech, instant Postgres, or a no-signup database are the same path.

## Neon Infrastructure as Code

`neon.ts` is Neon's branch config and infrastructure-as-code file: declare which Neon services your project's branches should have, get type-safe env vars, and program branch settings — all in TypeScript. It's the config layer for your Neon services, and it composes with the branch-first loop below. Add it with `@neon/config`:

```bash
npm i @neon/config
```

```typescript
// neon.ts
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  aiGateway: true,
  buckets: {
    images: {
      access: "private",
    },
  },
  functions: {
    imagegen: {
      name: "AI SDK image agent",
      source: "src/index.ts",
    },
  },
});
```

### Provision services with neon config

Every project ships with Lakebase Postgres; `neon.ts` also declares Auth, Functions, buckets, and the AI Gateway. Data API is a compatibility toggle, not part of a default backend:

```typescript
// neon.ts
export default defineConfig({
  auth: true,
  functions: {},
  buckets: {},
  aiGateway: true, // see the neon-ai-gateway skill
});
```

Empty `functions` / `buckets` maps are configuration slots, not a deployed API. Do not replace an existing `neon.ts` wholesale with this example.

Reconcile the declaration from the CLI — the Neon equivalent of `terraform status` / `plan` / `apply`:

```bash
neon status          # print the branch's live config (read-only). Alias for `neon config status`.
neon config plan     # dry-run diff of what apply would change (read-only)
neon deploy --env <file>  # apply neon.ts. Pass --env when Function env reads process.env. Alias for `neon config apply`
```

`apply` / `deploy` provision the declared services **and then pull the branch's env into your local `.env.local`** (e.g. `Pulled 5 Neon variables into .env.local: DATABASE_URL, …`), so your local env always matches what's deployed.

### Function env and `neon deploy`

`neon deploy` is the preferred full deployment: it applies `neon.ts` (services and functions) to the linked branch. `neon deploy --env <file>` loads that file into `process.env` before evaluating `neon.ts`, then uploads those values as Function env. Use it every time Function env reads `process.env`.

`<file>` is the gitignored file `neon env pull` already writes (`.env` if that file exists, otherwise `.env.local`). Env pull writes Neon-managed vars only (`DATABASE_URL`, `NEON_AI_GATEWAY_*`, …). Add every key under `functions.*.env` to that file yourself, then pass the same path to `--env`.

Every declared Function env key must be a defined string. `undefined` (an unset `process.env.X`) means you listed a key you want written but the value is missing: `defineConfig` throws. Omit the key from `neon.ts` if you do not want to write it. Never coerce a missing `process.env` value to an empty string: that uploads `""` and deletes the live key. An empty assignment in the file (`KEY=`) is also `""`. If TypeScript needs a type assertion, use `process.env.X!` and make sure the file actually has the value.

Use `neon functions deploy` when you are not applying `neon.ts`: a single function by slug, or a targeted `--env KEY=VALUE` update (that flag is not a file path).

### Function Triggers

A Function Trigger POSTs to a Neon Function on a cron (`type: "schedule"`) or when an object is created in a bucket (`type: "storage_object_created"`). Same regions as Functions. Prefer a `triggers` map in `neon.ts` (the record key is the trigger name) and `neon deploy`. CLI, MCP, REST, inherited-trigger behavior, and parsers: [references/function-triggers.md](https://neon.com/docs/ai/skills/neon/references/function-triggers.md). Handler payload and Hono example: the `neon-functions` skill, `references/function-triggers.md`.

### Type-safe env vars with parseEnv

`@neon/env`'s `parseEnv` returns a typed env object from your `neon.ts` config. Require a subset of keys when an app does not need every implied variable: [references/parse-env.md](https://neon.com/docs/ai/skills/neon/references/parse-env.md).

### Branch configuration

Beyond services, `neon.ts` can program what configuration _new_ branches receive via the `branch` property — a function of the branch being evaluated that returns its settings:

```typescript
// neon.ts
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
  branch: (branch) => {
    if (branch.exists) {
      // leave existing branches untouched
      return {};
    }
    if (branch.name.startsWith("dev")) {
      return {
        ttl: "7d", // clean up the branch after 7 days
        postgres: {
          computeSettings: {
            autoscalingLimitMinCu: 0.25, // scale to zero
            autoscalingLimitMaxCu: 1, // keep it cheap
            suspendTimeout: "5m",
          },
        },
      };
    }
    return {};
  },
});
```

The `branch` function receives the target branch (its `name`, whether it `exists` yet, whether it's the default, and more) and returns the tuning you want. Here new `dev-*` branches get a 7-day TTL so they clean themselves up, plus a cheap scale-to-zero compute profile, while existing branches and everything else fall through to the defaults. Because `neon checkout` applies this policy on create, a fresh `dev-*` branch comes up with these settings already in place.

### Type-safe config: invalid setups don't compile

Because `neon.ts` is TypeScript, the compiler catches invalid infrastructure before you ever deploy — and Neon encodes the actual rules (and their fixes) into the types, so the error tells you what to do rather than failing with a useless `Type 'true' is not assignable to type 'never'`. The canonical case, **when the app has chosen Data API for PostgREST/Supabase compatibility**: the Data API verifies requests with Neon Auth by default, so enabling it on its own is a type error _on_ `dataApi`. Do not enable Auth merely to satisfy this error in an app that never needed Data API.

```typescript
export default defineConfig({
  dataApi: true, // type error: `dataApi` (default authProvider 'neon') requires Neon Auth
});
```

The message names both fixes, so pick one:

```typescript
// 1. Enable Neon Auth (the default Data API auth provider):
export default defineConfig({ auth: true, dataApi: true });

// 2. Or verify a third-party IdP instead of Neon Auth:
export default defineConfig({
  dataApi: {
    authProvider: "external",
    jwksUrl: "https://your-idp/.well-known/jwks.json",
  },
});
```

Treat a `neon.ts` type error as the config telling you which services must go together — read the message, it spells out the valid combinations.

See https://neon.com/docs/reference/neon-ts.md for documentation on the `neon.ts` file.

## Branch-First Dev Flow

Neon branches enable a branch-first development flow, which we recommend when using Neon services. This and `neon.ts` above are the two halves of the recommended setup — `neon.ts` declares what every branch should have, and the branch-first loop is how you move between those branches day to day. Each works on its own, and they compose.

Create a Neon branch any time you would create a git branch. Use the following commands if you have CLI access:

- `neon checkout <branch-name>` — Pins an existing branch by updating only the branch pointer in `.neon`. Pass `--create` to create a missing **name** (`neon checkout dev --create`). Run without a name for an interactive picker. It does not touch code or local Postgres.
- `neon env pull` — Fetches the current branch's Neon environment variables into your `.env`. **`link` and `checkout` run this for you by default**, so you rarely call it directly.
- `neon diff` — Shows the schema diff between the child branch and its parent. Run this to see what changes have been made to the schema since the last branch was created and before you commit your changes.

```bash
neon link                     # once; also pulls the linked branch's env
neon checkout dev-add-search --create  # per feature; also pulls the branch's env
```

Because `link` and `checkout` pull env by default, the branch's `DATABASE_URL` lands in your local `.env` automatically — build against it, then `checkout` the next branch and repeat. As the agent, drive this loop yourself: run `checkout` between tasks.

### How checkout composes with neon.ts

When a `neon.ts` is present, `neon checkout <name> --create` applies your policy as it **creates** a branch, so a fresh branch comes up with its declared settings and services already in place. Pass `--env <file>` on that create so Function env that reads `process.env` resolves (`neon checkout feat --create --env .env.local`). Existing process env wins over the file. Checking out an _existing_ branch never reconciles it — apply config changes to it explicitly with `neon deploy --env <file>` (alias for `neon config apply`). `--update-existing` auto-confirms overriding remote settings; add it only after reviewing those changes. The bundled `env pull` also checks `neon.ts` against the linked branch and fails fast if the branch is missing a declared service, pointing you at `neon deploy --env <file>` to provision it, so your local env and the remote branch never drift apart silently.

### Opting out of local env vars

If env vars are injected at runtime instead of written to disk — or you simply don't want secrets in the working tree — pass `--no-env-pull` to `link` / `checkout` and supply the env another way:

- `neon-env run -- <your dev command>` (from `@neon/env`) injects the branch's vars at runtime.
- `neon-env export` prints dotenv or `--format json`.
- `fetchEnv` from `@neon/env` is the programmatic version.
- `neon dev` injects the same vars into the local Functions dev server.

When an agent should not write a local `.env`, instruct it (for example in your `AGENTS.md`) to run `neon checkout <branch> --no-env-pull` and rely on runtime injection.

For reading env you _already_ have on disk (typed and validated against your `neon.ts`), use `parseEnv` — see [Type-safe env vars with parseEnv](https://neon.com/docs/ai/skills/neon/references/parse-env.md).

## Observability

Neon exposes branch-scoped logs for Functions and Object Storage today (`aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, and `aws-ap-southeast-1`). Query the branch that hosts the deployed function or bucket, not the checkout used for development.

```bash
neon logs query --since 1h
neon logs query --branch production --source function --minimum-severity error --since 6h
```

CLI flags, LogQL, MCP fallback, Loki HTTP, Grafana URLs, and `@neon/sdk` pagination: [references/logs-loki.md](https://neon.com/docs/ai/skills/neon/references/logs-loki.md).

## Manage Neon Resources

Use [`@neon/sdk`](https://neon.com/docs/ai/skills/neon/references/sdk.md) to manage projects, branches, and snapshots from TypeScript. New code should prefer it over `@neondatabase/api-client`.

### Neon for (Agentic) Platforms

Enroll in the [Neon Agent Program](https://neon.com/programs/agents.md) only when the work is a fleet of user databases (app-generating agents and platforms). A single-app backend skips this. Instant provision, snapshots, scale-to-zero compute (storage still billed), Auth, and Data API compatibility details: that page.
