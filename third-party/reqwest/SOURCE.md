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

# Local patch: reqwest 0.13.5

Source: published crates.io reqwest 0.13.5, [revision de55373434f07f42926599dbb5a88550d8e55112](https://github.com/seanmonstar/reqwest/tree/de55373434f07f42926599dbb5a88550d8e55112). Original MIT and Apache-2.0 licenses retained; upstream.json records original file hashes.

`src/async_impl/client.rs` adds: an optional `ClientBuilder::connection_executor` hook supplies the executor used by the Hyper legacy client. The default still spawns on Tokio. Hyper uses this executor for connection drivers, HTTP/2 tasks, and idle-pool tasks.

Maka's `maka_network::ConnectionTasks` seals registration, aborts all registered tasks, and waits for their futures to drop. Dropping a response or send future alone cannot establish this: an early empty 413 response or a blocked socket flush can leave Hyper holding upload slices. The upload receipt separately checks physical source and byte-owner destruction after the drivers settle.

Host and model HTTP use a dedicated client per request/redirect hop. This intentionally gives up cross-request connection pooling and HTTP/2 multiplexing so cancelling one upload cannot abort another. Routing, proxy credentials, TLS verification, decompression and request options still use the existing Policy/reqwest stack. WebSocket/probe clients keep the default executor.

Regression coverage: host upload delayed real HTTP sink cancellation; model pending giant upload cancellation, early response close, replay-hop cancellation, redirect replay and response EOF tests. No timeout/assertion relaxation.


`src/tls.rs` adds the opaque snapshot type. The additional `Client::rustls_config()` accessor returns an opaque
`tls::RustlsConfig` snapshot of the fully resolved Rustls configuration. The
existing `tls_backend_preconfigured` builder accepts this snapshot. Both ordinary
and preconfigured Rustls clients retain their resolved configuration; snapshots
contain no connection pool, executor or body. This reuses reqwest's exact crypto
provider, certificate verifier, versions, SNI, keylog and ALPN settings, including
HTTP/2 when enabled, rather than reproducing TLS defaults in Maka. The connector
continues to derive its own HTTPS-proxy ALPN configuration without mutating the
snapshot. As with other preconfigured backends, TLS builder settings do not
override the supplied configuration.

Maka caches only successful snapshots per policy owner. The first real request
builds the snapshot; failed builds remain retryable. Subsequent request/hop clients
still have independent Hyper pools and owned connection executors. No process-wide
cache or runtime is added. Linux trust roots refresh on replacement of the policy
owner/cache, rather than every request; cloned Rustls configurations share their
bounded TLS session cache but no live connection. Regression tests cover failed
initial builds, two concurrent clients with independent physical connection
cleanup, and TLS snapshot/ALPN preservation through proxy connector construction.
