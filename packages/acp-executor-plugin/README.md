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

# ACP Executor Runtime Plugin

This package is the shared ACP transport and lifecycle layer. It provides `ctx.acp` to child Plugin
Entries. An external Agent package supplies only an `AcpAgentAdapter`; the service turns that adapter
into the generic executor contribution introduced by #5283.

Installing this package creates the `acp-runtime` profile Entry. Keep adapter Entries below it so the
service follows normal Plugin Context inheritance. The Host remains unaware of ACP and sees only
`ctx.executors` registrations.

Adapter packages register with `ctx.acp.register(ctx, adapter, config)`. Passing the adapter Entry's
Context explicitly is part of the package ABI: production packages are separate self-contained
bundles, and the shared runtime must register the executor against the consumer's scope rather than
against its parent Entry.
