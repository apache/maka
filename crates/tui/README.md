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

# Maka TUI

[简体中文](README.zh-CN.md)

Terminal client for the Runtime Host, launched by `maka tui`.

The sidebar groups sessions by workspace. **Needs you** filters that directory without leaving the current conversation. `Ctrl+B` opens navigation in a sheet on narrow terminals or in focus mode; `Esc` returns to the current draft. Tab crosses lists and fields, while arrow keys move within a list. `F1` opens help over the current page; Host connection details live in Settings.

`Enter` sends a message, or queues it for the next turn while the model is working. `Shift+Enter` inserts a new line on terminals with enhanced keyboard support; `Ctrl+J` works on legacy terminals, including Windows Terminal through WSL. Pasting multiple lines never sends them. `Ctrl+K` opens commands, `Ctrl+F` searches the conversation, and `Ctrl+N` creates a session. Dialogs and search keep their own input scope.

Chat and plugin transcripts share Markdown, selection, search and streaming presentation. New streamed text briefly fades to its final color without delaying the received content or changing its layout. Reduced motion and terminal-owned colors display it immediately.

- `maka-client` owns transport and protocol validation; the TUI owns presentation and input.
- Provider setup consumes public descriptors, configuration and authentication contracts.
- Local state stores drafts and recovery identities, never authentication input. Uncertain writes require observation, not automatic replay.
- Fluent catalogs cover English, Simplified Chinese and Traditional Chinese.
