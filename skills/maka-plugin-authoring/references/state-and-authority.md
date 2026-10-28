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

Keep an original mutation's `OperationReply.reference`. Only `receipt.kind === "recorded"` describes a journal outcome; inspect `outcome` and `cleanup`. An unknown result is not a failure or permission to issue a new mutation. Recover the exact reference after reconnecting. `not_recorded` and `unavailable` remain distinct observations.

Use `nsh.cleanup` for the subscriptions and timers created by a UI activation or component. Closing a view releases its component resources; disabling or replacing the instance releases its activation. In-flight Host operations retain their original caller and receipt rather than being replayed by a newly mounted component. `context.operations.pending()` and `recover(id)` expose this UI instance's unresolved operations and their original outcomes after reconnecting; `abandon(id)` only fences an attempt that never prepared.

Cancellation requests work to stop. Observer loss or a logically closed panel does not prove native I/O or processes have settled. Native work retains the actual Call resource ticket through physical completion, and cleanup failure remains visible to its original owner. See [Native Rust](native-rust.md).

JavaScript Host services have no ambient Node filesystem, network, credential or process APIs; effects go through their actual service imports. NSH UI modules use the NSH runtime and client capabilities available to the workbench.
