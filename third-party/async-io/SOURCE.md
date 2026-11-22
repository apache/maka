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

# async-io timer cancellation wake

Sources are copied from the published `async-io` 2.6.0 crate, [upstream revision 576b470ca3cadefdec8b169279df23c9a0a63495](https://github.com/smol-rs/async-io/tree/576b470ca3cadefdec8b169279df23c9a0a63495). Original Apache-2.0 and MIT license texts are preserved. `upstream.json` records the finite original inventory and SHA-256 hashes before modifications. Unused example, integration-test and benchmark targets are omitted from the normalized manifest; production dependencies are unchanged.

The only runtime change is `Reactor::remove_timer` calling its existing `notify` after enqueueing removal. Without that notification an idle reactor can remain parked on the cancelled timer's old deadline while retaining its Waker. Drop requests cancellation; the reactor processes removal and releases actual custody asynchronously. This is not a synchronous cleanup receipt. The application does not install another reactor, timer registry or I/O configuration.
