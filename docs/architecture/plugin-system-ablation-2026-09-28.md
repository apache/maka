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

# Plugin system ablation, 2026-09-28

This audit started from `origin/main` at `de4fc5ff95b1f8034ca00b448984b31ca711dce1`.
The constraint was to simplify implementation without changing exported APIs,
protocol shapes, persisted state, error text, or lifecycle behavior.

## Architecture retained

The plugin system has four distinct authorities:

1. `plugin-kernel.ts` owns Context views, Fiber lifecycle, dependency refresh,
   Services, Effects, and event dispatch.
2. `plugin-runtime.ts` and `plugin-composition-loader.ts` own desired Entry Tree
   reduction and live transactional activation respectively. The reducer is
   code-free and durable; the loader preserves live Fiber identity for
   non-structural updates and stages replacements before publication.
3. Runtime Host owns immutable package generations, package journals,
   composition authority, recovery, reconciliation, bounded protocol queries,
   and Client generation fences.
4. Client Runtime owns trusted Renderer bundles, typed recursive Slots, staged
   UI activation, Remote streams, and product-event subscriptions.

These are not duplicate layers. Each has a different failure boundary and is
covered by tests that assert rollback, recovery, stale-generation rejection,
or renderer isolation.

## Ablations kept

### Host runtime binding state

Agent, Attachment, Filesystem, Goal, LLM, Session Query, Shell, Web, Settings,
Storage, and Credential services repeated the same state machine:

- only a Host Context may bind;
- a second live binding is rejected;
- the binding is owned by a Context Effect;
- disposal only clears the runtime generation it installed;
- capability use fails while no runtime is bound.

The repeated state is now owned by one internal `PluginRuntimeBinding`. Public
Service classes and their `bindRuntime` methods remain unchanged. The current
caller Context is still passed at bind time, preserving Service proxy authority
instead of capturing the constructor's root Context.

### Composition Entry value mechanics

The reducer and live loader separately implemented recursive Entry walking and
the same clone/deep-freeze rules for `inject`, `isolate`, `intercept`, and
`children`. Those mechanics now live in one internal module. Generation rules,
operation validation, staging, rollback, and live publication remain with their
existing owners.

The runtime package exports no new subpath, and no exported declaration was
added or removed.

## Ablations rejected

- Replacing live loader mutations with `applyCompositionState` plus full-tree
  replacement would restart unrelated Fibers and break config-update identity.
- Folding package store, composition store, and Host platform together would
  erase the journal/authority ordering used to recover unknown commit outcomes.
- Generalizing protocol decoders or Client Slot kinds further would reduce
  local code at the cost of making wire and UI compatibility less explicit.
- Combining Host and Client activation would cross the Node/Renderer privilege
  boundary and weaken the content-digest and generation fences.

## Verification

- Runtime typecheck and build passed.
- Runtime Host, UI, and Desktop test builds passed.
- Focused plugin coverage passed: 203 tests, including package recovery,
  composition rollback, contribution scoping, Client Remote streams, typed
  Slots, and the added Host-binding authority/rebinding regression.
- Biome lint and formatting passed for every changed source file.
