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

# maka-providers

[简体中文](README.zh-CN.md)

Supplies compiled model-provider definitions. `api` covers API-backed providers and `codex` implements the Codex provider integration. The native service selects a definition explicitly. Provider transport and credentials use the caller's capabilities and configuration.

Codex owns subscription configuration, authentication and model discovery. Its execution adapter lives in [model::adapters](../model/src/adapters.rs), where it composes the ordinary Responses adapter. Provider definitions do not own model execution sessions.

API request options follow the resolved protocol, including provider aliases, model overrides and protocol alternates. Declared thinking choices use the same preparation policy for selectable metadata, main requests, automatic titles and recaps. An explicit Anthropic parallel-tool opt-out is encoded in the request. Native preparation diagnostics retain fixed local rejection reasons while keeping arbitrary provider error text private.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)

Model discovery follows provider pagination to its terminal response and rejects repeated continuation tokens; numbered pages advance by their checked page position. Page sizes and concurrent account requests bound live work, not the full account/model inventory. Complete model metadata and authentication values remain intact; the Host owns transport admission and cleanup settlement. OAuth device authorization expiry and token refresh follow provider lifecycle semantics.
