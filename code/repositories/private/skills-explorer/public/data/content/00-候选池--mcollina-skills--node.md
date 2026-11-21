---
name: node
description: Provides domain-specific best practices for Node.js development with TypeScript, covering type stripping, async patterns, error handling, streams, modules, testing, performance, caching, logging, and more. Use when setting up Node.js projects with native TypeScript support, configuring type stripping (--experimental-strip-types), writing Node 22+ TypeScript without a build step, or when the user mentions 'native TypeScript in Node', 'strip types', 'Node 22 TypeScript', '.ts files without compilation', 'ts-node alternative', or needs guidance on error handling, graceful shutdown, flaky tests, profiling, or environment configuration in Node.js. Helps configure tsconfig.json for type stripping, set up package.json scripts, handle module resolution and import extensions, and apply robust patterns across the full Node.js stack.
metadata:
  tags: node, nodejs, javascript, typescript, type-stripping, backend, server
---

## When to use

Use this skill whenever you are dealing with Node.js code to obtain domain-specific knowledge for building robust, performant, and maintainable Node.js applications.

## TypeScript with Type Stripping

When writing TypeScript for Node.js, use **type stripping** (Node.js 22.6+) instead of build tools like ts-node or tsx. Type stripping runs TypeScript directly by removing type annotations at runtime without transpilation.

Key requirements for type stripping compatibility:

- Use `import type` for type-only imports
- Use const objects instead of enums
- Avoid namespaces and parameter properties
- Use `.ts` extensions in imports

**Minimal example** — a valid type-stripped TypeScript file:

```ts
// greet.ts
import type { IncomingMessage } from "node:http";

const greet = (name: string): string => `Hello, ${name}!`;
console.log(greet("world"));
```

Run directly with:

```bash
node greet.ts
```

See [rules/typescript.md](rules/typescript.md) for complete configuration and examples.

## Common Workflows

For multi-step processes, follow these high-level sequences before consulting the relevant rule file:

**Graceful shutdown**: Register signal handlers (SIGTERM/SIGINT) → stop accepting new work → drain in-flight requests → close external connections (DB, cache) → exit with appropriate code. See [rules/graceful-shutdown.md](rules/graceful-shutdown.md).

**Error handling**: Define a shared error base class → classify errors (operational vs programmer) → add async boundary handlers (`process.on('unhandledRejection')`) → propagate typed errors through the call stack → log with context before responding or crashing. See [rules/error-handling.md](rules/error-handling.md).

**Diagnosing flaky tests**: Isolate the test with `--test-only` → check for shared state or timer dependencies → inspect async teardown order → add retry logic as a temporary diagnostic step → fix root cause. See [rules/flaky-tests.md](rules/flaky-tests.md).

**Diagnosing stuck processes/tests** (`node --test` hangs, "process did not exit", CI timeout, open handles): isolate file/test → run with explicit timeout/reporter → inspect handles via `why-is-node-running` (`SIGUSR1`) → patch deterministic teardown in resource-creation scope → rerun isolated + full suite until stable. See [rules/stuck-processes-and-tests.md](rules/stuck-processes-and-tests.md).

**Profiling a slow path**: Reproduce under realistic load → capture a CPU profile with `--cpu-prof` → identify hot functions → check for stream backpressure or unnecessary serialisation → validate improvement with a benchmark. See [rules/profiling.md](rules/profiling.md) and [rules/performance.md](rules/performance.md).

## High-priority activation checklist (streams + caching)

When the task mentions **CSV**, **ETL**, **ingestion pipelines**, **large file processing**, **backpressure**, **repeated lookups**, or **deduplicating concurrent async calls**, explicitly apply this checklist:

1. Use `await pipeline(...)` from `node:stream/promises` (prefer this over chained `.pipe()` in guidance/code).
2. Include at least one explicit `async function*` transform when data is being transformed in-stream.
3. Choose a cache strategy when repeated work appears:
   - `lru-cache` for bounded in-memory reuse in a single process.
   - `async-cache-dedupe` for async request deduplication / stale-while-revalidate behavior.
4. Show where backpressure is handled (implicitly via `pipeline()` or explicitly via `drain`).

### Integrated example pattern (CSV/ETL)

For CSV/ETL-style prompts, prefer an answer structure like:

- `createReadStream(input)`
- `async function*` parser/transform
- optional cached enrichment lookup (`async-cache-dedupe` or `lru-cache`)
- `await pipeline(...)` to a writable destination

Link relevant rules directly in explanations so models can retrieve details:

- [rules/streams.md](rules/streams.md)
- [rules/caching.md](rules/caching.md)

## How to use

Read individual rule files for detailed explanations and code examples:

- [rules/error-handling.md](rules/error-handling.md) - Error handling patterns in Node.js
- [rules/async-patterns.md](rules/async-patterns.md) - Async/await and Promise patterns
- [rules/streams.md](rules/streams.md) - Working with Node.js streams
- [rules/modules.md](rules/modules.md) - ES Modules and CommonJS patterns
- [rules/testing.md](rules/testing.md) - Testing strategies for Node.js applications
- [rules/flaky-tests.md](rules/flaky-tests.md) - Identifying and diagnosing flaky tests with node:test
- [rules/stuck-processes-and-tests.md](rules/stuck-processes-and-tests.md) - Diagnosing processes that do not exit and tests that get stuck
- [rules/node-modules-exploration.md](rules/node-modules-exploration.md) - Navigating and analyzing node_modules directories
- [rules/performance.md](rules/performance.md) - Performance optimization techniques
- [rules/caching.md](rules/caching.md) - Caching patterns and libraries
- [rules/profiling.md](rules/profiling.md) - Profiling and benchmarking tools
- [rules/logging.md](rules/logging.md) - Logging and debugging patterns
- [rules/environment.md](rules/environment.md) - Environment configuration and secrets management
- [rules/graceful-shutdown.md](rules/graceful-shutdown.md) - Graceful shutdown and signal handling
- [rules/typescript.md](rules/typescript.md) - TypeScript configuration and type stripping in Node.js
