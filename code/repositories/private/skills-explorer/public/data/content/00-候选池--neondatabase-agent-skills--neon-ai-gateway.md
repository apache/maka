---
name: neon-ai-gateway
description: >-
  One API and one credential for frontier and open-source LLMs, built into your
  Neon branch and powered by Databricks. Use when a user wants to call an LLM,
  add AI/chat/an agent to their app, route between model providers (OpenAI,
  Anthropic, Google/Gemini, Meta, Alibaba, and more), or avoid juggling
  separate provider API keys and accounts — especially when they already use
  Neon and want AI requests to branch with their project. Works with the OpenAI
  SDK, Anthropic SDK, google-genai, the Vercel AI SDK, and Mastra by changing
  only the base URL. Triggers include "call an LLM", "add AI to my app",
  "chat completion", "model routing", "LLM proxy/gateway", "one API for all
  models", "use Claude/GPT/Gemini", "AI SDK", "Mastra agent", "Neon AI
  Gateway", and "log/rate-limit AI calls".
metadata:
  parent: neon
  source: https://github.com/neondatabase/agent-skills/tree/main/skills/neon-ai-gateway
---

**FIRST**: Use the parent `neon` skill for a Neon overview, getting started with Neon, Neon development best practices, and more.

If the `neon` skill is not installed, fetch it from https://neon.com/docs/ai/skills/neon/SKILL.md or install it with:

```bash
neon skills -s neon -y
```

# Neon AI Gateway

Currently available in `aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, and `aws-ap-southeast-1`.

The Neon AI Gateway is the LLM inference layer built into your Neon branch: one API and one Neon credential give you access to frontier and open-source models from many providers (Anthropic, OpenAI, Google, Meta, and more), all hosted and powered by Databricks. The catalog shifts over time, so treat `/v1/models` and the [models.dev Neon page](https://models.dev/providers/neon) as the source of truth rather than a fixed provider list. Your existing OpenAI/Anthropic/Gemini SDK works by changing only the base URL.

Use this skill to help the user send model calls through the gateway, wire it into the AI SDK or Mastra, and switch providers without rewiring code. Deliver a working inference request, a configured agent, or a precise answer from the official Neon docs.

## When to Use

Reach for the AI Gateway whenever an app or agent needs to call an LLM and the user would rather not manage model providers themselves:

- **One credential instead of many provider accounts.** A single Neon credential reaches the entire model catalog across every provider Databricks hosts. No separate OpenAI / Anthropic / Google billing, keys, or signups to provision and rotate.
- **Switch models without rewiring.** The unified endpoint is OpenAI-compatible and works with every model in the catalog — change one `model` field to move between Claude, GPT, and Gemini. Standard SDKs (OpenAI, Anthropic, google-genai) work with just a base-URL change.
- **AI follows your branches.** Each branch has its own gateway endpoint, scoped with the same lineage as your database. AI requests from a preview/feature branch are isolated to that branch — the same isolation your data already gets — which makes preview, CI, and agent environments self-contained.
- **No extra infrastructure, and it's already next to your data.** The gateway lives inside your Neon project (and is injected into Neon Functions automatically), runs on the same Databricks infrastructure that serves trillions of tokens a month, and supports streaming (SSE) out of the box.

If the user already has a deep, single-provider integration and no interest in Neon branching or multi-model routing, a direct provider SDK is fine — but the moment they want one credential, model portability, or branch-scoped AI, this is the reason to use it.

## What It Does

- **One API for all models** — Frontier and open-source models behind a single endpoint, addressed by their catalog ID (e.g. `claude-sonnet-4-6`, `gpt-5-mini`, `gemini-3-flash`).
- **Standard SDKs, one URL change** — OpenAI SDK and AI SDK (OpenAI-compatible MLflow/Responses routes), Anthropic SDK (native Messages), google-genai (native Gemini).
- **Branch-scoped** — Each branch gets its own gateway host; the Neon credential authorizes requests for that branch and its descendants.
- **Streaming** — Server-sent events work on all endpoints with no extra configuration.

## Availability

Check these preconditions before setting anything up:

The AI Gateway is currently available in `aws-us-east-2`, `aws-us-east-1`, `aws-eu-central-1`, and `aws-ap-southeast-1`. Foundation model access requires a paid Neon plan. Confirm the user's project is in one of these regions.

### Enabling the gateway: plan and model-catalog gating

The AI Gateway is credential-gated rather than a provisioning step, but two plan limits gate it — one blocks provisioning, the other only trims the catalog — and the CLI surfaces each:

- **Free plan → provisioning is blocked.** `neon config apply` / `deploy` and `neon checkout` **refuse** to enable the gateway on a Free plan (the gateway can't serve requests there), with a friendly "upgrade to a paid plan, or remove `aiGateway`" error. A dry-run `neon config plan` and `neon env pull` don't provision, so they only **warn**. So: to use the gateway the project's account must be on a paid Neon plan.
- **Paid plan with a reduced model catalog.** On a paid plan the gateway provisions and serves, but an account can start with a trimmed catalog — some flagship models (e.g. Anthropic Opus, OpenAI Codex / `*-pro`) are missing from `GET /v1/models`. This is expected; `neon env pull` (and the env pull bundled into `apply` / `deploy` / `checkout`) warns and links the user to their branch's AI Gateway page in the Neon Console (`https://console.neon.tech/app/projects/<project-id>/branches/<branch-id>/ai-gateway`) to request access to more models. Verify what's actually available for the branch by reading `/v1/models` (see the models section below) rather than assuming the full catalog.

When helping a user debug "the gateway isn't working" or "a model is missing", use `/v1/models` plus the account's plan to distinguish these two cases — a Free plan blocks provisioning entirely, while a reduced catalog on a paid plan just needs a model-access request.

## Setup

The gateway is part of `neon.ts` (see the `neon` skill for the branch-first workflow and `neon.ts` basics). Enable it with `aiGateway`:

```typescript
// neon.ts
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  aiGateway: true,
});
```

```bash
neon deploy   # provisions the gateway on the linked branch
```

## Neon Infrastructure as Code (`neon.ts`)

The `aiGateway` toggle above is part of `neon.ts`, Neon's infrastructure-as-code file — one TypeScript file declares the gateway alongside every other branch service, in version control (see the `neon` skill for the full reference). Reconcile it against a branch the Terraform way:

```bash
neon config status   # print the branch's live config (is the gateway on?)
neon config plan     # dry-run diff of what apply would change
neon config apply    # enable the gateway on the branch  (neon deploy is an alias)
```

The gateway is **branch-scoped**: each branch gets its own gateway host. When a `neon.ts` is present, `neon checkout` applies the policy as it _creates_ a branch, so a fresh preview/CI branch comes up with the gateway already enabled. Checking out an _existing_ branch doesn't reconcile it — run `neon deploy` to apply changes. Provisioning (`config apply` / `deploy`), `link`, and `checkout` also pull the branch's gateway credentials into your local `.env.local`, so local runs hit the same branch gateway as the deployed function (no manual `env pull` needed).

## Environment Variables

When `aiGateway` is enabled, Neon injects the gateway credentials as **Neon-branded** env vars. Inside a deployed Neon Function these are injected automatically; locally, `neon env pull` writes them to `.env`/`.env.local` (or use `neon-env run -- <cmd>` to inject at runtime without a file):

| Variable                   | Meaning                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `NEON_AI_GATEWAY_TOKEN`    | Gateway bearer token (a Neon credential, `nt_live_...`)                                                                             |
| `NEON_AI_GATEWAY_BASE_URL` | **Bare branch gateway host** (`scheme://host`, **no path** — no `/ai-gateway`): `https://<branch-id>-api.ai.<region>.aws.neon.tech` |

> Neon injects **only** these two vars — it does **not** set `OPENAI_API_KEY` / `OPENAI_BASE_URL`. The `@neon/ai-sdk-provider` and Mastra's `neon/<model>` read `NEON_AI_GATEWAY_*` directly (zero config); for the plain OpenAI SDK / `@ai-sdk/openai`, build the client's `apiKey` + `baseURL` from them (shown below), or set your own `OPENAI_*` by hand (`env pull` leaves user-set vars untouched).

`NEON_AI_GATEWAY_BASE_URL` is the **bare host** — you append the dialect path yourself (which is exactly what the `@neon/ai-sdk-provider` does for you). The routes under the host are:

- `/v1` — unified, OpenAI **Chat Completions**-compatible; recommended default, works with every provider (`/v1/chat/completions`).
- `/openai/v1` — OpenAI **Responses** API (required for `gpt-5-…-codex` variants and `gpt-5-5-pro`); the `@ai-sdk/openai` provider uses the Responses API by default (`/openai/v1/responses`).
- `/anthropic` — native Anthropic Messages (extended thinking, prompt caching). Give the Anthropic SDK this as its base URL and it appends `/v1/messages` itself, so the full request path is `/anthropic/v1/messages`.
- `/gemini` — native Gemini `generateContent`. Give google-genai this as its base URL and it appends `/v1beta/models/<model>:generateContent` itself, so the full request path is `/gemini/v1beta/models/<model>:generateContent`.

So `${NEON_AI_GATEWAY_BASE_URL}/v1` is the chat-completions endpoint and `${NEON_AI_GATEWAY_BASE_URL}/openai/v1` the OpenAI Responses endpoint (both appended by you); for the native Anthropic and Gemini dialects you hand the SDK the shorter `/anthropic` or `/gemini` base and it appends the rest. See [Use with Plain SDKs](#use-with-plain-sdks-lower-level) below.

For typed, validated access to the injected credentials, pass the same `neon.ts` config object to `parseEnv` from `@neon/env` — it returns an `env.aiGateway` namespace (`apiKey`, `baseUrl`) derived from your config.

## Build Agents with the Vercel AI SDK (Recommended)

The [Vercel AI SDK](https://ai-sdk.dev) is the recommended way to call the gateway and build agents from TypeScript: one set of primitives (`generateText`, `streamText`, tool calling, structured output) over every catalog model, with first-class streaming for the long agent responses Neon Functions are built to host.

The dedicated `@neon/ai-sdk-provider` reads `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN` from the injected env with **zero config** and routes each model to the best endpoint (Anthropic → Messages, OpenAI/Codex → Responses, everything else → MLflow). On a Neon Function that streams text and generates images, just pick a catalog model:

```typescript
import { neon } from "@neon/ai-sdk-provider";
import { streamText } from "ai";

const result = streamText({
  model: neon("gpt-5-mini"), // or claude-sonnet-4-6, gemini-3-flash, ...
  messages,
  tools: {
    image_generation: neon.tools.imageGeneration({
      outputFormat: "jpeg",
      size: "1024x1024",
    }),
  },
});
return result.toUIMessageStreamResponse();
```

A single completion is the same provider with `generateText`:

```typescript
import { neon } from "@neon/ai-sdk-provider";
import { generateText } from "ai";

const { text } = await generateText({
  model: neon("claude-haiku-4-5"), // or gpt-5-3-codex, gemini-3-flash, ...
  prompt: "Summarize Postgres for me.",
});
```

> Prefer `@neon/ai-sdk-provider` over the bare `@ai-sdk/openai` `openai()`: Neon injects only `NEON_AI_GATEWAY_*`, not `OPENAI_*`, so `openai()` won't pick up the gateway from the env on its own. If you do use `@ai-sdk/openai`, configure it explicitly with `createOpenAI({ apiKey: process.env.NEON_AI_GATEWAY_TOKEN, baseURL: `${process.env.NEON_AI_GATEWAY_BASE_URL}/openai/v1` })`.

To build an **agent** — a model that calls tools in a loop and then answers — add `tools` and a `stopWhen` budget. The loop runs in-process, so on a Neon Function it isn't cut off by lambda-style timeouts:

```typescript
import { neon } from "@neon/ai-sdk-provider";
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";

const { text } = await generateText({
  model: neon("claude-sonnet-4-6"),
  prompt: "How many open todos do I have, and what's the oldest one?",
  tools: {
    listTodos: tool({
      description: "List the user's open todos.",
      inputSchema: z.object({}), // AI SDK v5+: `inputSchema`, not `parameters`
      execute: async () => db.select().from(todos),
    }),
  },
  stopWhen: stepCountIs(5), // let the model call tools, then summarize
});
```

For a full AI SDK agent deployed as a Neon Function (streaming, tool calling, image generation, persistence), see the `neon-functions` skill's [references/ai-sdk.md](https://neon.com/docs/ai/skills/neon-functions/references/ai-sdk.md).

## Build Agents with Mastra (Recommended)

[Mastra](https://mastra.ai) is the recommended framework when you want batteries-included agents — built-in memory, tools, workflows, and tracing — with the model still pointed at the gateway. With `@mastra/core` 1.47+, use a `neon/<model>` magic string; Mastra reads `NEON_AI_GATEWAY_BASE_URL` and `NEON_AI_GATEWAY_TOKEN` from the environment (injected by `neon deploy` when `aiGateway` is enabled). Use `parseEnv` only for other declared services (e.g. `env.postgres.databaseUrl` for `@mastra/pg` memory):

```typescript
import { Agent } from "@mastra/core/agent";
import { parseEnv } from "@neon/env";
import config from "../neon";

const env = parseEnv(config);

export const personalAssistant = new Agent({
  id: "personal-assistant",
  name: "personal-assistant",
  instructions: "You are a warm, concise personal assistant with long-term memory.",
  model: "neon/claude-haiku-4-5",
  memory, // your Mastra memory store, e.g. @mastra/pg on env.postgres.databaseUrl
});
```

## Use with Plain SDKs (Lower-Level)

When you don't need an agent framework — a single completion, an existing provider-SDK integration, or native provider features — call the gateway with the plain SDKs. Neon injects the `NEON_AI_GATEWAY_*` vars (not `OPENAI_*`), so set the client's `apiKey` + `baseURL` from them. For the OpenAI **Responses** dialect (`/openai/v1`):

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.NEON_AI_GATEWAY_TOKEN,
  baseURL: `${process.env.NEON_AI_GATEWAY_BASE_URL}/openai/v1`,
});

const res = await client.responses.create({
  model: "gpt-5-mini", // swap to claude-sonnet-4-6, gemini-3-flash, ...
  input: "What is Neon?",
});
```

For the unified **chat-completions** dialect, point `baseURL` at `/v1` instead:

```typescript
const client = new OpenAI({
  apiKey: process.env.NEON_AI_GATEWAY_TOKEN,
  baseURL: `${process.env.NEON_AI_GATEWAY_BASE_URL}/v1`,
});

const res = await client.chat.completions.create({
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "What is Neon?" }],
});
```

The Anthropic SDK and google-genai work the same way for native provider features — point the Anthropic SDK at `${NEON_AI_GATEWAY_BASE_URL}/anthropic` (it appends `/v1/messages` itself) and google-genai at `${NEON_AI_GATEWAY_BASE_URL}/gemini` (it appends `/v1beta/models/...`).

## Model Identifiers

Use a model's catalog ID directly in the `model` field — e.g. `claude-sonnet-4-6`, `gpt-5-mini`, `gemini-3-flash`. No provider prefix is needed. To look up the exact identifiers the gateway serves, which underlying model each maps to, and their context windows, pricing, and capabilities, use any of:

- **models.dev Neon provider page: https://models.dev/providers/neon** — the canonical, always-current list of the Neon provider's model IDs and their underlying models. The machine-readable catalog is at https://models.dev/api.json (the `neon` key).
- **Models doc:** see Further Reading.

## List Available Models at Runtime (`/v1/models`)

The gateway also exposes the model catalog **live from your own branch endpoint**, so an app or agent can discover exactly which models this branch serves without hard-coding the list. It is an OpenAI-compatible list endpoint, served **only on the unified dialect** (`/v1`):

```bash
curl "$NEON_AI_GATEWAY_BASE_URL/v1/models" \
  -H "Authorization: Bearer $NEON_AI_GATEWAY_TOKEN"
```

- `GET ${NEON_AI_GATEWAY_BASE_URL}/v1/models` → **200**
- `GET ${NEON_AI_GATEWAY_BASE_URL}/openai/v1/models` → **404** (not served on the Responses dialect — use `/v1`)

**Getting the credentials for the request.** Both values come from the same branch-scoped Neon credential the gateway uses everywhere else — you never manage a provider key:

- **Provision via `neon.ts` (recommended).** Enable `aiGateway` in `neon.ts` and run `neon deploy` (or `neon config apply`). Provisioning, `neon link`, and `neon checkout` pull `NEON_AI_GATEWAY_TOKEN` + `NEON_AI_GATEWAY_BASE_URL` into your local `.env.local`; inside a deployed Neon Function they're injected automatically. See **Setup** and **Environment Variables** above.
- **Pull into the environment via CLI.** `neon env pull` writes the two vars to `.env`/`.env.local`, or `neon-env run -- <cmd>` injects them at runtime without a file — but only when `neon.ts` declares `aiGateway`; the vars are never pulled off branch state alone.
- **Provision via the Console UI.** Enable the AI Gateway on the branch in the Neon Console and copy the branch's gateway base URL and a Neon credential (token) from the project's connection/credentials view.

Any Neon credential (`nt_live_...`) valid for the branch works as the bearer token; `NEON_AI_GATEWAY_BASE_URL` is the bare branch host (no path).

**Response shape** — OpenAI/OpenRouter-compatible list:

```jsonc
{
  "object": "list",
  "data": [
    {
      "id": "claude-sonnet-4-6", // catalog model ID — use directly in the `model` field
      "canonical_slug": "claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6", // human-readable display name
      "object": "model",
      "owned_by": "anthropic", // provider slug, e.g. anthropic | openai | google | meta | alibaba | databricks | ... (non-exhaustive; read live)
      "created": 0,
      "enabled": true,
      "context_length": null,
      "architecture": {
        "modality": "text->text",
        "input_modalities": ["text"],
        "output_modalities": ["text"],
        "tokenizer": "Claude", // Claude | Gemini | GPT | "" (empty for open-source)
        "instruct_type": null,
      },
      "top_provider": {
        "is_moderated": false,
        "context_length": null,
        "max_completion_tokens": null,
      },
      "pricing": null,
      "per_request_limits": null,
    },
    // ... one entry per model in the branch's catalog
  ],
}
```

> Note: `context_length`, `pricing`, and `per_request_limits` are currently `null` and `created` is `0` for every entry — for context windows, pricing, and capabilities use the models.dev catalog above. Use `/v1/models` when you need the live, branch-scoped list of servable model IDs (e.g. to populate a model picker or validate a `model` before a request).

## Neon Documentation

The Neon documentation is the source of truth and the AI Gateway is evolving rapidly, so always verify against the official docs. Any doc page can be fetched as markdown by appending `.md` to the URL or by requesting `Accept: text/markdown`. Find the right page from the docs index (https://neon.com/docs/llms.txt) and the changelog announcements.

## Further Reading

- https://neon.com/docs/ai-gateway/overview.md
- https://neon.com/docs/ai-gateway/get-started.md
- https://neon.com/docs/ai-gateway/models.md
- https://neon.com/docs/ai-gateway/chat-completions.md
- https://neon.com/docs/ai-gateway/anthropic-messages.md
- https://neon.com/docs/ai-gateway/openai-responses.md
- https://neon.com/docs/ai-gateway/gemini.md
- https://neon.com/docs/ai-gateway/authentication.md
- https://neon.com/docs/ai-gateway/troubleshooting.md
