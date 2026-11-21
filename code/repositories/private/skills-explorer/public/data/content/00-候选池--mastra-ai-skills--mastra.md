---
name: mastra
description: "Comprehensive Mastra framework guide for building agents, workflows, tools, memory, workspaces, and storage with current APIs. Use for documentation lookup, API verification, TypeScript setup, common errors, migrations, and `mastra api` CLI tasks: inspect or call resources on local, Mastra platform, Trace Intelligence, or remote servers. For Mastra Factory operations, discover and activate the companion mastra-factory skill."
license: Apache-2.0
metadata:
  author: Mastra
  version: "2.2.0"
  repository: https://github.com/mastra-ai/skills
---

# Mastra Framework Guide

Build AI applications with Mastra. This skill teaches you how to find current documentation and build agents and workflows.

## Critical: Do not trust internal knowledge

Everything you know about Mastra is likely outdated or wrong. Never rely on memory. Always verify against current documentation.

Your training data contains obsolete APIs, deprecated patterns, and incorrect usage. Mastra evolves rapidly - APIs change between versions, constructor signatures shift, and patterns get refactored.

## Prerequisites

Before writing any Mastra code, check if packages are installed:

```bash
ls node_modules/@mastra/
```

- If packages exist: Use embedded docs first (most reliable)
- If no packages: Install first or use remote docs

## Resources

### References

| User Question                                                              | First Check                                                            | How To                                                                          |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Create/install Mastra project                                              | [`references/create-mastra.md`](references/create-mastra.md)           | Setup guide with CLI and manual steps                                           |
| Choose Agent/Workflow/Tool/Memory/Storage                                  | [`references/core-concepts.md`](references/core-concepts.md)           | Core concepts and when to use each primitive                                    |
| How do I use Agent/Workflow/Tool?                                          | [`references/embedded-docs.md`](references/embedded-docs.md)           | Look up in `node_modules/@mastra/*/dist/docs/`                                  |
| How do I use X? (no packages)                                              | [`references/remote-docs.md`](references/remote-docs.md)               | Fetch from `https://mastra.ai/llms.txt`                                         |
| Choose or validate a model                                                 | [`references/model-selection.md`](references/model-selection.md)       | Model format and provider registry lookup                                       |
| I'm getting an error...                                                    | [`references/common-errors.md`](references/common-errors.md)           | Common errors and solutions                                                     |
| Upgrade from v0.x to v1.x                                                  | [`references/migration-guide.md`](references/migration-guide.md)       | Version upgrade workflows                                                       |
| Inspect/call server resources via CLI                                      | [`references/mastra-api.md`](references/mastra-api.md)                 | `mastra api` CLI for local, Mastra platform, or remote servers                  |
| Find exact traces with complex predicates                                  | [`references/trace-query.md`](references/trace-query.md)               | Query completed traces by trace fields or related spans, scores, and feedback   |
| Investigate agent health, recurring failures, or improvement opportunities | [`references/trace-intelligence.md`](references/trace-intelligence.md) | Start with aggregate Trace Intelligence themes, then inspect trace/log evidence |

### Scripts

- `scripts/provider-registry.mjs`: Look up current providers and models available in the model router. Always run this before using a model to verify provider keys and model names.

## Priority order for writing code

Never write code without checking current docs first.

1. Embedded docs first (if packages installed)

   Look up current docs in `node_modules` for a package. This matches the exact installed version and is the most reliable source of truth. See [`references/embedded-docs.md`](references/embedded-docs.md).

2. Source code second (if packages installed)

   If embedded docs don't cover the question, inspect the installed source and type definitions. This is the source of truth when docs are missing or unclear. See [`references/embedded-docs.md`](references/embedded-docs.md).

3. Remote docs third (if packages not installed)

   Use the latest published docs when packages are not installed or when exploring new features. Remote docs may be ahead of the user's installed version. See [`references/remote-docs.md`](references/remote-docs.md).

## Core concepts

Use [`references/core-concepts.md`](references/core-concepts.md) when choosing between agents, workflows, tools, memory, and storage.

- Agent: Use for open-ended tasks that make decisions and use tools.
- Workflow: Use for defined multi-step processes.

## Mastra Studio

Studio is the interactive UI for building, testing, and managing agents, workflows, and tools. Use Studio when advising a human to inspect or debug visually.

Inside a Mastra project, run:

```bash
npm run dev
```

Then open `http://localhost:4111` in a browser to show Mastra Studio to your human user.

## Mastra API CLI

Use `mastra api` to inspect or call resources on local dev servers, Mastra platform deployments, or remote Mastra endpoints. It is useful for agent-readable state, execution, traces, logs, scores, threads, and workflow operations. See [`references/mastra-api.md`](references/mastra-api.md) for usage patterns.

For exact trace selection that needs recursive predicates or conditions over related spans, scores, or feedback, read [`references/trace-query.md`](references/trace-query.md). Before using `mastra api trace query`, confirm that the installed CLI exposes the command. Use `--schema` for the target's request/response shape and structural constraints, and use the canonical documentation found through [`references/remote-docs.md`](references/remote-docs.md) for supported fields, operators, and semantics. Preserve opaque pagination cursors and fetch trace or span details only after selecting candidates.

## Mastra Factory

For Factory projects, work items, queue health, decisions, session history, memory inspection, or authorized operations, activate the **`mastra-factory`** skill. Factory is an operational control plane, not a reason to scaffold or deploy a new Mastra app.

If the skill is missing, offer to install it from this repository:

```bash
npx skills add mastra-ai/skills --skill mastra-factory
```

Choose the user's intended agent and scope interactively. For global installation, target a supported agent explicitly with `--agent <agent> -g`; PromptScript does not support global installs. Verify installation and referenced files for the intended agent even if another agent target fails.

The Factory skill covers CLI checks, `mastra auth whoami` / authorized `mastra auth login`, and connecting via the user's actual instance URL from any directory. A deployed repository or `.mastra-project.json` is not required with `--url`. Never guess a shared Factory host or project IDs. Its connection and session-inspection references cover deployment-specific authentication, project discovery, threads, and observational memory limitations.

## Trace Intelligence

Trace Intelligence (private beta on the Mastra platform) clusters completed agent traces into recurring themes across four trace signals: goal, outcome, behavior, and sentiment. Use it first for aggregate agent-health questions: what users ask for, where outcomes fail or get blocked, which behaviors recur, how sentiment shifts, and where the agent can improve. Then use `mastra api trace`, `log`, `metric`, and `score` commands for concrete execution evidence from specific traces. Query Trace Intelligence with `mastra api learning` CLI commands, or over HTTP via the local dev server proxy or the platform endpoint. See [`references/trace-intelligence.md`](references/trace-intelligence.md) for the investigation workflow, CLI commands, and route reference.

## Critical requirements

### TypeScript config

Mastra requires ES2022 modules. CommonJS will fail. See [`references/create-mastra.md`](references/create-mastra.md) for setup and [`references/common-errors.md`](references/common-errors.md) for troubleshooting.

### Model format

Always use `"provider/model-name"` when defining models using Mastra's model router.

When the user asks to use a model or provider, always run `scripts/provider-registry.mjs` first to verify the provider key and model name are valid. Do not guess model names from memory as they change frequently. See [`references/model-selection.md`](references/model-selection.md).

## When you see errors

Type errors often mean your knowledge is outdated.

Common signs of outdated knowledge:

- `Property X does not exist on type Y`
- `Cannot find module`
- `Type mismatch` errors
- Constructor parameter errors

What to do:

1. Check [`references/common-errors.md`](references/common-errors.md)
2. Verify current API in embedded docs
3. Don't assume the error is a user mistake - it might be your outdated knowledge

## Development workflow

Always verify before writing code:

1. Check whether Mastra packages are installed
2. Look up current API
   - If installed: Use embedded docs [`references/embedded-docs.md`](references/embedded-docs.md)
   - If not: Use remote docs [`references/remote-docs.md`](references/remote-docs.md)
3. Write code based on current docs
4. Test with the project scripts or Studio when available
