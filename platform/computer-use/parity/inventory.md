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

# Static capability inventory

[`inventory.mjs`](../../../scripts/computer-use-parity/inventory.mjs) enumerates
the original runtime's machine-readable API and selected client syntax, then
compares those names with Maka's facade and protocol. It reads an explicitly
supplied runtime tree and Maka checkout. It never acquires an app, starts the
runtime, executes target JavaScript, accesses a desktop or modifies approvals.

The output is a source inventory, **not a passing behavior result**. It records
names, structured default-availability flags, source identities and pointers.
It excludes declaration text, descriptions, instruction bodies, source fragments
and application binaries. Keep generated ledgers outside Git.

## Run

For the machine JSON inventory alone:

```sh
node scripts/computer-use-parity/inventory.mjs \
  --runtime /absolute/installed-app/resources/cua_node \
  --output /absolute/private-evidence/capability-inventory.json
```

The runtime manifest supplies the platform, architecture, runtime identity and
`node_modules` layout. Every `environment-docs/**/api.json` is enumerated,
including undocumented members. A missing `documents.json` leaves its API
members in the ledger and records a separate document-condition unknown.
App version and official identity/signature are not inferred from the runtime
manifest; those remain separate evidence obligations. No version or component
hash selects or refuses the supplied app.

For the command registry, native wrappers and Maka facade, also supply an
**existing development Babel parser**:

```sh
node scripts/computer-use-parity/inventory.mjs \
  --runtime /absolute/installed-app/resources/cua_node \
  --maka /absolute/source/maka \
  --parser-module /absolute/existing/node_modules/@babel/parser/lib/index.js \
  --output /absolute/private-evidence/capability-inventory.json
```

The tool does not install that parser. Its module and package manifest hashes,
version, host Node version, tool hash, invocation and working directory are
recorded. The parser runs as an operator-supplied development tool; it reads
target JavaScript as inert syntax. A parser inside the target runtime is refused.
Without a parser, registry/facade/type-member extraction stays explicitly unknown;
the tool does not silently substitute text searching or claim an empty surface.

Output must be outside the runtime and source checkout. Files must be new unless
`--overwrite` is supplied. Even then, parser inputs, hard-linked files and files
inside the protected runtime/source trees cannot be replaced. Existing symlink
parents are resolved before applying that rule.

## What is enumerated

The verified development fixture used for the first inventory contains these
declarations; these counts describe that input rather than a compatibility gate:

| Source scope | Result |
| --- | --- |
| Machine API profiles | `cloud`, `codex-app`, `orbit`, `training` |
| Each profile | 22 interfaces, 147 interface members, 66 named types |
| Document-condition rows | 19, 26, 20 and 12 respectively |
| Client `commandType` registrations | 94 resolved names; no unresolved registration in that input |
| Capability registrations | 8 families |
| Collection type members outside the 147 | `BrowserCapabilityCollection.get/list`, `TabCapabilityCollection.get/list` |
| Unified target wrappers | 12 members each for macOS, Linux, Windows and browser tabs |

The eight capability IDs are `botDetection`, `cdp`, `browserAuth`, `pageAssets`,
`webmcp`, `management`, `visibility` and `viewport`. Class-declared methods are
retained separately from factory-declared methods. Computed methods or an
unresolved registration add an unknown rather than disappearing from the count.
Runtime-created namespaces, factory behavior and provider implementation remain
outside this declaration inventory.
Injected instance fields, including `documentation`, are retained as field names;
the inventory does not guess their callable behavior from the field name.

The API JSON is fully traversed. Member IDs such as `PlaywrightLocator.fill` and
`TabClipboardAPI.write` retain a JSON pointer and file SHA-256. The client registry
and selected native sources retain full-file identity and UTF-16 source ranges.
There are no item-count truncation limits. Files excluded from source analysis,
symlinks not followed and unrecognized syntax are reported.

The original per-member `unsupportedByDefaultIn` flags remain distinct from
default reachability through parent interfaces. For example, an available-looking
`AXAPI.click` declaration does not make `Tab.ax` available by default. Neither
state proves that a connected backend supports the operation: runtime capability
overrides, grants and provider behavior require observation.

Native source extraction also retains unconditional wrapper refusals. In the
identified fixture these include Linux `selectText` and `setValue`, and Windows
`selectText`. The [behavior ledger](verification.md#source-evidence-and-platform-differences)
preserves the separate scroll-unit and paste-format boundaries. Do not treat a
source-declared native client function as a verified helper feature or silently
replace these platform differences with a universal API.

The related retained REA audio analysis is
`ev_8f65f0d8cb3e95cd88cf6147d621607ca374dd2b797f3b888293f808973ecaba`
(summary `ev_9015d8f727058f31eec7b97e59ef21aca32f0e2e6916347a2198a9cc377eb1dd`).
It covers selected three-platform audio/client JavaScript and declarations while
leaving 202 inventoried files unselected. Authority-policy analysis
`ev_a8ca2c28587a09f535c9846da196482abb6998e289dc308d06f95771c233985f`
(summary `ev_019943a24a928431cfe1bde5f940afbd125472eddaa609f6990dfd86d297fd82`)
covers selected macOS/Windows policy and client wrappers, with 207 files
unselected. Both identify the Sky artifact SHA-256
`71d2a64db3d7b74c00cdb73bf47cbee76d60e7611e4c6e23f2aced25c5c22957`.
They are static source evidence and do not establish native capture, user approval
or desktop behavior. The separate unified-facade REA identity is recorded in the
[behavior ledger](verification.md#source-evidence-and-platform-differences).

## Maka comparison and remaining evidence

For each original interface member, the ledger reports either a same-named
member in an inspected Maka object literal, an absent member within that finite
literal, a dynamic surface, or an unresolved interface. The unified facade and
native client names have separate comparison tables. Platform-conditional literal
spreads retain their source guard; a Windows-only `launch_app` declaration does
not establish Linux exposure.

These are source-exposure classifications. A matching name does not prove
compatible arguments, return values, ownership, authorization or native effects.
An unresolved helper-produced object is not classified as an empty interface.
Rust protocol variants are recorded from the full named enum block and its
current formatting; this is separate from proving that a dispatch handler works.
All implementation and behavior fields remain `unverified`.

The first fixture leaves three displayed function types per profile unparsed:
`PlaywrightEvaluateFunction`, `LocatorEvaluateFunction` and
`LocatorEvaluateAllFunction`. Their names and source identities remain present.
This does not omit any of the 147 structured interface member rows. The inventory
also leaves browser-service/provider implementation, native binary exports,
original host services, runtime capability overrides and live platform behavior
unverified.

`case_family_mapping` links complete member-name groups to related scenarios in
the initial 33-case manifest and explicitly lists members without such a link.
Those links are planning relationships, not per-member test receipts. Downloads,
Playwright, clipboard, content export, dialogs, history and optional capability
families retain their original declarations even when Maka lacks a corresponding
surface or a behavioral test. Do not shrink the reference inventory to the
currently implemented subset.

Re-run after changing the app/runtime or Maka source; the ledger includes exact
source hashes. Real comparison still requires independently recorded effects
through the [behavior comparator](verification.md). macOS and Windows declarations
inside a Linux package do not establish live macOS or Windows verification.

## Check the inventory tool

```sh
MAKA_PARITY_PARSER_MODULE=/absolute/existing/node_modules/@babel/parser/lib/index.js \
  node --test scripts/computer-use-parity/inventory.test.mjs
```

The tests use synthetic source and temporary directories. They check complete
declaration retention, default-disabled parent paths, privacy filtering,
unconditional async refusal recognition, source-exposure uncertainty and output
preservation. Without the parser, syntax tests skip explicitly; machine-JSON and
CLI tests still run. These are tool tests, not desktop integration evidence.
