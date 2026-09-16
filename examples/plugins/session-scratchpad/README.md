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

# Session Scratchpad dogfood plugin

Session Scratchpad is a complete trusted Host + Client plugin. It adds a **Scratchpad** action to
each conversation header and stores one durable note per Session. Open windows converge through a
backpressured Client Remote stream, and the panel displays live Tool activity observed through the
public product-event contract.

It deliberately exercises the whole Client plugin stack:

- unified manifest, immutable generation, and `profile` + `desktop-ui` composition;
- Host-scoped durable plugin storage with compare-and-swap writes;
- Standard Schema-validated Client RPC and Pull Stream handlers;
- generation- and Session-fenced Renderer calls;
- `conversation.header.actions` and `shell.overlay` typed Slots;
- lifecycle-owned CSS, stream cleanup, and `tool.activity` subscription.

After building Maka and starting its Runtime Host, install the example from the checkout root:

```sh
node packages/cli/dist/dev-cli.js runtime-host plugin install \
  examples/plugins/session-scratchpad --root /path/to/state-root
```

Use `runtime-host plugin reload maka.session-scratchpad` after editing the package, or uninstall it
with `runtime-host plugin uninstall maka.session-scratchpad`. The package uses only public plugin
contracts and does not need Renderer Node access or private Maka UI imports.
