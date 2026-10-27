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

# Maka workbench

The Agent workbench that Maka's shells run: an NSH application written in TSX (`app/`), the native bindings through which it reaches a public Host (`src/bindings.rs`), and its native Markdown component (`src/markdown.rs`).

The build bundles `app/App.tsx` into the crate (`APPLICATION`, with its imported files in `ApplicationAssets`). A shell connects to the Host, admits itself with `host::admit`, creates `bindings::Bindings` for that connection, and completes `configuration` with its own viewport, environment and data directory before running it in its NSH backend. The [terminal shell](../terminal-shell/README.md) runs it in a terminal and the [desktop shell](../desktop-shell/README.md) in a window. On a graphical desktop, `app/chrome.ts` makes the headers along the window's top edge its title bar and sets the application menu.

`cargo run -p maka-workbench --example ui_types` prints the TypeScript declarations of the Markdown module.
