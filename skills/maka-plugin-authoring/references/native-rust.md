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

# Native Rust plugins

A native package entry selects an implementation compiled into the executable. Keep its `IMPLEMENTATION` identifier, contracts and configuration schema together in a `NativeDefinition`. Schema generation exposes that definition through `sdk.nativeImplementations`; `package.ts` consumes it rather than duplicating the contract.

For a Host service, implement the factory in the owning plugin crate and register it through `provide(&mut NativeRegistry)`. The Maka product selects that provider in `products/maka/native`. The composition still has to create an instance and bind its imports. See `plugins/skills/native` and `plugins/workspace/workspace-web/native` for examples.

A factory receives `NativeContext` and configuration. Return a `NativeActivation` with validated exports and a `NativeOwner` that can close acquired resources, including resources acquired before initialization fails. The context carries the actual activation, selected package, captured imports and optional persistence.

Durable data belongs to the Root, deployment and instance. An activation epoch or package revision does not create a new data owner. Services that require persistence must reject an ephemeral context.

A handler uses the original `Context.scope()` and actual attachments. Retain call resource tickets until native I/O and workers have finished. `NativeOwner.close` reports physical settlement; dropping an observer or requesting cancellation is insufficient. Cleanup failure must remain visible to the owner.

`NativeServices` forwards through captured imports with private native-origin evidence. Public identity fields are observations, not grants. Declare an `execution_basis` only when immutable facts fully establish equivalent execution semantics; otherwise retain activation-specific identity.

NSH Rust components are registered through `nsh_core::element::Registry` and supplied in the workbench's `EngineConfig.ui_sets`. Keep native entities and resource lifetime with the actual backend owner. Shared NSH components work across supported backends; a platform-native leaf needs that backend's implementation. A dynamically installed UI module uses the already registered components; adding a new Rust implementation requires rebuilding the executable.
