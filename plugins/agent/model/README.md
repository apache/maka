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

# maka-model

[简体中文](README.zh-CN.md)

Builds model requests and streams responses through provider adapters. `ModelExecutor` manages requests, `Conversation` builds conversation input, and `reasoning` handles reasoning configuration. Provider credentials arrive through `AuthResolver`; the caller supplies authorized network and accounting context.

Chat Completions compatible and Anthropic Messages use the pure Rust [protocol core](../provider-protocol/README.md). The native adapter releases request bodies after dispatch; an open stream holds no input-size admission quota. Queued output shares a 32 MiB byte window until consumed. One larger atomic event owns the whole window while its journal fragments drain, so this is backpressure rather than a response-size cap. The idle deadline covers network waits, excluding output backpressure.

Canonical response items and text remain complete across HTTP, SSE, WebSocket and durable reconstruction. Chunking and bounded channels apply backpressure without a separate whole-response quota. Disposable continuation caches may be evicted; canonical history remains the recovery source. Request token selection, provider protocol validation and owned idle/cancellation cleanup stay separate from content retention.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
