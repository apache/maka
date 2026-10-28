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

# maka-provider-protocol

[简体中文](README.zh-CN.md)

Encodes Responses, Chat Completions compatible and Anthropic Messages requests and decodes complete or streaming responses. Protocol-owned input and output types separate wire state from the Host's canonical history. Provider extensions remain explicit JSON values at the wire boundary.

The crate owns incremental SSE framing, tool identities, reasoning, citations, usage and hosted-tool replay. [maka-model](../model/README.md) supplies authorized transport, credentials, cancellation, timeouts and byte reservations. This crate performs no network or runtime work.

The Chat Completions codec covers compatible providers. Responses preserves accepted-item metadata, text-part boundaries, encrypted reasoning and replay formats. Model and subscription policies belong to the execution adapters. The Messages codec excludes Files, Batch, Decisions and Skills administration endpoints.

Chat Completions and Anthropic behavior was verified against unchanged selected upstream tests at the revision recorded in the [source audit](../../../docs/code-origin-audit.md). Temporary upstream tests and validation bindings are kept outside the product. First-party regressions are maintained alongside each protocol implementation.

The Chat Completions and Anthropic SSE decoder limits one unfinished record to 64 MiB to bound malformed or unterminated provider input, with room for atomic records larger than 32 MiB. Completed records transfer their buffers instead of retaining peak capacity. The complete response can contain any number of records.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
