<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

@.agents/AGENTS.md

- Follow [CONTRIBUTING.md](CONTRIBUTING.md).
- Choose the simplest complete design for real requirements; do not add abstractions, configuration, or compatibility layers for hypothetical needs.
- Validate at system boundaries and trust internal contracts; do not duplicate checks or hide errors behind fallbacks.
- Encode invariants in types so illegal states are unrepresentable; use enums for state machines and newtypes for identities and units.
- Keep ownership explicit and prefer borrowing; do not clone data or stack `Arc` / `Mutex` to work around the borrow checker.
- Use `Option` for expected absence and `Result` for expected failure; preserve error causes and never swallow errors silently.
- Test observable behavior rather than implementation details. Keep only tests that catch real regressions; avoid duplicate assertions and brittle implementation-coupled checks.
- Evaluate cost at real data scale, runtime duration, and concurrency—not just small inputs or single-call latency.
- Keep hot paths focused on required data; avoid full scans, redundant computation or copies, and unbounded state growth.
- Account for reads, writes, cache maintenance, cleanup, and recovery together so fixes do not shift bottlenecks onto another path.
- Minimize shared state and lock contention; never perform unrelated I/O or slow work while holding a lock.
- Never run blocking I/O or long-running CPU work on async executor threads.
- Verify indexes, caches, and batching against real execution paths; when fixing one site, audit all peer paths.
- Let layout speak for itself. Communicate intent through structure, hierarchy, and interaction rather than slogans, decoration, or explanatory filler.
- Keep comments sparse and explain only critical invariants, trade-offs, or safety preconditions that code cannot express; update or remove stale comments with the code.
- Confine `unsafe` to the smallest possible boundary, document the safety invariant, and wrap it in a safe interface.

## Persisted State & Upgrade Compatibility

- Upgrade forward in place—do not accumulate legacy read-time branches in business logic. When changing SQLite schemas or persisted JSON payloads, upgrade existing databases directly to the current shape via atomic migrations so runtime reads/writes target one schema, without external migration scripts.
- Published migrations are immutable: SHA-384 digests of `migrations/*.sql` (`event-log`, `agent/state`, `settings/store`, `cli/deployment`) are locked in `scripts/rust/migrations.lock.json` (`node scripts/ci.mjs check migrations`). Append higher-numbered migrations only; use `Migration::with_data` for JSON/data rewrites that SQL cannot express cleanly, committing or rolling back atomically inside the same `SAVEPOINT`.
- Distinguish authoritative facts from derived state: `RootMarker`, event facts/history, Settings/Vault, Deployment, Checkpoints, and unsettled `application_operations` must migrate forward; derived indexes (such as Recall/FTS) may use versioned drop-and-rebuild.
- Whenever persisted tables, on-disk JSON payloads, or core stateful features change, update the full-scenario upgrade harness [upgrade_compat.rs](tools/upgrade-compat/src/upgrade_compat.rs). Post-merge `compat-post-merge.yml` on `main` and the shared pre-release `compat-gate` replay historical time capsules to verify cold migrations, exhaustive reads, and live continuation.

## CI Maintenance

- Maintain test suites and entrypoints centrally in [scripts/ci.mjs](scripts/ci.mjs) and its modules; `just` and workflows reuse those definitions. Update routing, archive assets, and result aggregation whenever suites are added or moved.
- When changing SDKs, plugins, fixtures, build scripts, or embedded assets, verify actual consumers and update non-Cargo input dependencies. Bundled skill Markdown and similar assets are product inputs and must not be skipped by extension.
- Verify workspace feature unification semantics before narrowing test compilation scope. When changing archives, check runtime `OUT_DIR` assets and child executables, and validate with existing behavioral tests on an independent runner.
- When changing routing or sharding, verify affected transitive dependents still run; unified checks must fail if a planned job is skipped, cancelled, failed, or produces an unexpectedly empty full test run.
