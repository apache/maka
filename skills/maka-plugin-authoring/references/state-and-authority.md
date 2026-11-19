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

# State, authority and settlement

A package revision identifies immutable bytes; an instance UUID identifies a state owner. Configuration revision, activation epoch and individual invocation identify different changes. Preserve instance identity when updating a package or its configuration.

UI modules, including the selected root application, are trusted code in the shared NSH client VM. Their NSH activation owners govern views, reactive state and subscriptions; they are not separate permission domains. The UI can use the client's existing capabilities. The deployment's `ui` selector owns the application choice; activation failures do not authorize choosing a different root. `UiEntry.imports` and composition bindings select services exposed through `context.application` and `context.services`; calls capture the actual UI consumer session and providers. `context.services` selects individual providers for imports with cardinality `many`. The native application client shares the original Client, journal and mutation receipts. Trusted code retains the full `context.host` client. Durable business state belongs to the owning Host service rather than a second UI cache.

An instance's `UiActivation` owns its controllers and `prepareReload()` handoff. Embedded views receive typed presentation inputs, including the owning controller's actions where needed. Unmounting a view preserves activation-owned state. Before a shared VM reload, every active instance can save drafts and return JSON; the matching instance and package receive that JSON through `context.restored`. Keep mutation receipts with their original operation instead of recreating work during restoration.

Host services use their captured imports and the resources supplied by the actual request. Host grants identify caller/origin, consumer, provider, export and methods. Recovery retains its own grant and exact persisted owner. A package declaration or service directory describes an interface; it does not replace the current Host publication and configured grants.

Keep an original mutation's `OperationReply.reference`. Only `receipt.kind === "recorded"` describes a journal outcome. Inspect `outcome` and `cleanup` independently: a `returned` outcome contains `result.kind === "success"` with `value`, or `result.kind === "failure"` with `diagnostic`. A returned failure is a known handler result, not proof that no effects occurred. A known result does not confirm physical cleanup, and confirmed cleanup does not make an unknown result known.

An unknown result is not permission to issue another mutation. Recover the exact reference after reconnecting; never rebuild it from current import bindings. `not_recorded` means no provider receipt was found, **not** that execution was prevented. Only the original provider's fenced `not_executed` proof establishes that. An unknown result can later resolve through original authoritative evidence; a definite result cannot be rewritten by a retry or a human risk decision.

Host callers supply an opaque `recovery` object with each `mutate` request. Freeze the exact final input and safe resource sources before admission; large inputs should use readable immutable content references rather than digests alone. Incoming attachment slot names and metadata are not durable resource grants. If a resource cannot be safely reacquired, record that limitation and block recovery rather than guessing. JSON integers must be exactly representable in JavaScript, and the complete recorded caller intent must fit the 1 MiB intent-page budget.

If the original mutation reply was lost before its reference reached the caller, `lookupIntent` takes the original `operationId` in the actual consumer's namespace. It returns the recorded intent and original reference, or `null` only after an authorized successful lookup. Errors, unavailable storage and collected evidence are not absence proofs. After an intent is found, observe its exact original operation; do not invoke a replacement handler. Neither the opaque recovery data nor the reference restores an execution grant.

For pure local state, a JavaScript Host callback can read its own captured instance with `stateRead` / `stateScan`, then return `await context.invoke({ operation: 'completeState', mutations, value })`. This seals a write description, not a committed write. Return that same JSON value and make no later Host requests. The Host validates the output and commits the state changes and original provider result in one Root transaction. A thrown exception, VM loss or mismatched callback return does not publish the draft. Compare the actual key revision when preparing a mutation; deleted keys retain revisions.

Use `nsh.cleanup` for the subscriptions and timers created by a UI activation or component. Closing a view releases its component resources; disabling or replacing the instance releases its activation. In-flight Host operations retain their original caller and receipt rather than being replayed by a newly mounted component. `context.operations.pending()` and `recover(id)` expose this UI instance's unresolved operations and their original outcomes after reconnecting; `abandon(id)` only fences an attempt that never prepared.

Cancellation requests work to stop. Observer loss or a logically closed panel does not prove native I/O or processes have settled. Native work retains the actual Call resource ticket through physical completion, and cleanup failure remains visible to its original owner. See [Native Rust](native-rust.md).

JavaScript Host services have no ambient Node filesystem, network, credential or process APIs; effects go through their actual service imports. NSH UI modules use the NSH runtime and client capabilities available to the workbench.
