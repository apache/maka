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

# maka-responses

[简体中文](README.zh-CN.md)

Implements the Responses protocol: request encoding, stream decoding, SSE handling and connection lanes. Connections are disposable transport state; canonical conversation and execution facts stay with the Agent owner. Start with `Adapter`, `request` and `stream`.

Requests hold an immutable prepared wire view. HTTP consumes bounded JSON chunks directly from that view; WebSocket sends the same chunks as Text/Continuation fragments and never assembles a complete outgoing message. Retries reopen the same captured source. Prefix identities and indexed suffix metadata validate continuations without re-reading old message bodies.

The connection cache stores only request properties and the response ID. Canonical accepted-item metadata retains phase, status, annotations and text-part boundaries without another copy of the text, so full replay preserves these fields after reconnect or compaction. Cancelling an active fragmented send retires the socket and releases its source and I/O buffers.

Only explicitly small in-memory requests use per-message encoding at send time. Persisted requests must provide matching prepared wire chunks; a missing or mismatched codec requires recapture. Dirty-group preparation still follows the source Message allocation contract, while ordinary HTTP/WebSocket uploads have bounded buffers independent of history and item size.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
