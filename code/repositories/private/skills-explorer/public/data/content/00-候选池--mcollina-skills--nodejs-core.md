---
name: nodejs-core
description: Contributes to and debugs Node.js core, including nodejs/node commit and PR tone, contribution workflows, native crashes, V8 performance, node-gyp builds, N-API bindings, and libuv issues. Use when drafting or reviewing a Node.js core commit or pull request, working in nodejs/node, or diagnosing C++ addons, binding.gyp failures, segfaults, native leaks, V8 deoptimizations, and event-loop internals.
metadata:
  tags: nodejs, nodejs-core, contributing, commit-message, pull-request, v8, libuv, cpp, native-addons, performance, debugging, internals
---

## When to use

Use this skill when you need deep Node.js internals expertise, including:

- C++ addon development
- V8 engine debugging
- libuv event loop issues
- Build system problems
- Compilation failures
- Performance optimization at the engine level
- Understanding Node.js core architecture
- Writing or reviewing `nodejs/node` commits and pull request descriptions

## How to use

Read individual rule files for detailed explanations and code examples:

### V8 Engine

- [rules/v8-garbage-collection.md](rules/v8-garbage-collection.md) - Scavenger, Mark-Sweep, Mark-Compact, generational GC
- [rules/v8-hidden-classes.md](rules/v8-hidden-classes.md) - Hidden classes, inline caching, optimization
- [rules/v8-jit-compilation.md](rules/v8-jit-compilation.md) - TurboFan, optimization/deoptimization patterns

### libuv

- [rules/libuv-event-loop.md](rules/libuv-event-loop.md) - Event loop phases, timers, I/O, idle, check, close
- [rules/libuv-thread-pool.md](rules/libuv-thread-pool.md) - Thread pool size, blocking operations, UV_THREADPOOL_SIZE
- [rules/libuv-async-io.md](rules/libuv-async-io.md) - Async I/O patterns, handles, requests

### Native Addons

- [rules/napi.md](rules/napi.md) - N-API development, ABI stability, async workers
- [rules/node-addon-api.md](rules/node-addon-api.md) - C++ wrapper patterns, best practices
- [rules/native-memory.md](rules/native-memory.md) - Buffer handling, external memory, prevent leaks

### Core Modules Internals

- [rules/streams-internals.md](rules/streams-internals.md) - How Node.js streams work at C++ level
- [rules/net-internals.md](rules/net-internals.md) - TCP/UDP implementation, socket handling
- [rules/fs-internals.md](rules/fs-internals.md) - libuv fs operations, sync vs async
- [rules/crypto-internals.md](rules/crypto-internals.md) - OpenSSL integration, performance considerations
- [rules/child-process-internals.md](rules/child-process-internals.md) - IPC, spawn, fork implementation
- [rules/worker-threads-internals.md](rules/worker-threads-internals.md) - SharedArrayBuffer, Atomics, MessageChannel

### JavaScript Internals

- [rules/primordials.md](rules/primordials.md) - **Using primordials to prevent prototype pollution (required for `lib/internal/`)**

### Build & Contributing

- [rules/build-and-test-workflow.md](rules/build-and-test-workflow.md) - **The edit-build-lint-test cycle (start here)**
- [rules/pre-commit-lint.md](rules/pre-commit-lint.md) - **Mandatory lint, format, and `core-validate-commit` gate for every commit so CI passes first time**
- [rules/configure.md](rules/configure.md) - `./configure` flags for debug builds, ASan, Ninja, etc.
- [rules/build-system.md](rules/build-system.md) - gyp, ninja, make, cross-platform compilation
- [rules/cli-options.md](rules/cli-options.md) - Adding CLI options and gating experimental modules
- [rules/contributing.md](rules/contributing.md) - How to contribute to Node.js core, the process
- [rules/commit-and-pr-guideline.md](rules/commit-and-pr-guideline.md) - Commit message and PR description style, trailers, DCO sign-off, and validation
- [rules/reviewing-prs.md](rules/reviewing-prs.md) - Reviewing PRs for correctness, clarity, and contribution quality

### Documentation

- [rules/documentation.md](rules/documentation.md) - **Updating doc/api/\*.md files: structure, link ordering, error docs, code example constraints**

### Debugging & Profiling

- [rules/debugging-native.md](rules/debugging-native.md) - gdb, lldb, debugging C++ addons
- [rules/profiling-v8.md](rules/profiling-v8.md) - --prof, --trace-opt, --trace-deopt, flame graphs
- [rules/memory-debugging.md](rules/memory-debugging.md) - Heap snapshots, memory leak detection

## Instructions

### Node.js contribution writing

When drafting a `nodejs/node` commit or pull request, read
[rules/commit-and-pr-guideline.md](rules/commit-and-pr-guideline.md).
Use terse subsystem-prefixed titles and plain, matter-of-fact prose. Lead with
concrete behavior, explain the reason for the change, and omit hype, canned
headings, file-by-file narration, and unsupported claims. Include the
contributor's DCO sign-off, and never add `PR-URL:` or `Reviewed-By:` — those
are added when the change lands. Validate the result with
`npx core-validate-commit --no-validate-metadata <sha>` in the `nodejs/node`
checkout.

### MANDATORY: Rebuild before testing

Node.js embeds `lib/` JavaScript files into the binary at compile time via
`js2c`. **After ANY change to `src/` or `lib/`, you MUST rebuild before
running tests.** Without a rebuild, tests run against stale code and results
are meaningless.

```
edit src/ or lib/  →  make -j$(nproc)  →  make lint  →  then test
```

Never skip the rebuild step. Never run `./node test/...` after editing
without building first.

Before starting work, **ask the user** about their build configuration
(Make vs Ninja, debug vs release, what configure flags they use). Do not
assume a specific setup. Most of the time, `./configure` has already been
run and only `make -j$(nproc)` is needed to rebuild.

### MANDATORY: Lint and format before every commit

Node.js runs a `Linters` CI workflow on every non-draft pull request, and on
Unix `make test` runs **no** linters. Run `make lint` before each `git
commit` — plus `make format-cpp` for C++ changes — so the lint jobs pass on
the first CI run instead of costing a force-push and another full cycle.

```bash
make -j$(nproc)                                        # rebuild first
make lint                                              # JS, C++, MD, docs, YAML

# C++ changes only — use the merge-base form, which is what CI checks:
CLANG_FORMAT_START="$(git merge-base HEAD upstream/main)" make format-cpp
git --no-pager diff --exit-code                        # must be empty

git add -A && git commit -s                            # -s is mandatory
npx core-validate-commit --no-validate-metadata HEAD
```

Never skip a step because the change looks trivial, and never commit with
"will fix lint in a follow-up".

**Bare `make format-cpp` is not enough.** It defaults to
`CLANG_FORMAT_START=HEAD` and formats only _staged_ changes, while the
`format-cpp` CI job formats everything from the merge base and fails on any
resulting diff — so unformatted code committed earlier in the branch passes
locally and fails in CI. Always pass the merge-base form shown above.

**Every commit must be created with `git commit -s`.** The `-s` flag adds the
`Signed-off-by:` trailer certifying the Developer Certificate of Origin.
Without it the `signed-off-by` rule of `core-validate-commit` fails and the PR
cannot land. The sign-off must be the human contributor's name and email —
never sign off with a tool or AI identity, and never fabricate someone else's.
If you forget it, amend with `git commit --amend --signoff`.

`make lint` runs `lint-js`, `lint-cpp`, `lint-addon-docs`, `lint-md`, and
`lint-yaml` — it does not cover every CI lint job. Python (`make lint-py`),
shell (`tools/lint-sh.mjs .`), C++ formatting, and commit-message validation
are separate jobs. See [rules/pre-commit-lint.md](rules/pre-commit-lint.md)
for the full gate and the CI-job-to-command mapping.

Validate every commit message with `core-validate-commit`, always with
`--no-validate-metadata` — metadata validation is on by default and enforces
trailers that only exist after landing. **Never add `PR-URL:` or
`Reviewed-By:` to a commit you author**; the landing process adds them.

See [rules/build-and-test-workflow.md](rules/build-and-test-workflow.md)
for the full workflow including configure flags, lint targets, and test
commands.

### Core knowledge domains

Apply deep knowledge of Node.js internals across these domains:

- **Core architecture**: Node.js core modules and their C++ implementations, V8 GC and JIT, libuv event loop mechanics, thread pool behavior, startup/module-loading lifecycle
- **Native development**: N-API, node-addon-api, and NAN addon development; V8 C++ API handle management; memory safety; native debugging with gdb/lldb
- **Build systems**: node-gyp, gyp, ninja, make; cross-platform compilation; linker errors; dependency issues; platform-specific considerations (Windows, macOS, Linux, embedded)
- **Performance & debugging**: Event loop profiling, memory leak detection in JS and native code, CPU flame graphs, V8 optimization/deoptimization tracing

### Quick-reference debugging commands

**V8 optimization tracing:**

```bash
node --trace-opt --trace-deopt script.js
# Checkpoint: confirm no unexpected deoptimization warnings before proceeding to profiling
node --prof script.js && node --prof-process isolate-*.log > processed.txt
```

**Event loop lag detection:**

```bash
node --trace-event-categories v8,node,node.async_hooks script.js
```

**Native addon debugging (gdb):**

```bash
gdb --args node --napi-modules ./build/Release/addon.node
# Inside gdb:
run
bt        # backtrace on crash
# Checkpoint: verify backtrace shows the expected call site before applying a fix
```

**Heap snapshot for memory leaks:**

```bash
node --inspect script.js   # then open chrome://inspect, take heap snapshot
# Checkpoint: compare two consecutive heap snapshots to confirm leak growth before and after the fix; run valgrind --leak-check=full node addon_test.js to confirm no native leaks remain
```

### Node.js-specific diagnostic decision trees

**Segfault / crash in native addon:**

1. Is the crash reproducible with `node --napi-modules`? → Run `gdb`, capture `bt`
2. Does `bt` point to a V8 handle scope issue? → Check `HandleScope` / `EscapableHandleScope` usage in the addon
3. Does it point to a libuv callback? → Inspect async handle lifetime and `uv_close()` sequencing
4. No clear C++ frame? → Check for JS-side type mismatches passed into the native binding

**V8 deoptimization / performance regression:**

1. Run `--trace-opt --trace-deopt` → identify the deoptimized function and reason (e.g., "not a Smi", "wrong map")
2. Checkpoint: confirm the same function deoptimizes consistently across runs
3. Inspect hidden class transitions (`--trace-ic`) and fix property addition order or type inconsistencies
4. Re-run `--trace-opt` to confirm the function is now optimized

**Build failure (node-gyp / binding.gyp):**

1. Is it a missing header? → Verify `include_dirs` in `binding.gyp` and Node.js header installation
2. Is it a linker error? → Check `libraries` and `link_settings` entries; confirm ABI compatibility
3. Is it platform-specific? → Consult `rules/build-system.md` for Windows/macOS/Linux differences

Always consider both JavaScript-level and native-level causes, explain performance implications and trade-offs, and indicate the stability status of any experimental features discussed. Code examples should demonstrate Node.js internals patterns and be production-ready, accounting for edge cases typical developers might miss.
