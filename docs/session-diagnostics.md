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

# Collect evidence for a Desktop conversation problem

[简体中文](./session-diagnostics.zh-CN.md)

Open the affected task before collecting evidence. For an assistant to read the
conversation, save it as Markdown. For a crash, failed request, or disconnected
Runtime Host, also copy diagnostics. These exports answer different questions.

## What happened to the file path in Trace?

The old **record file** row showed the workspace's shared `runtime.sqlite`
database, not a separate text file for the selected conversation. It was added
in [#2196](https://github.com/apache/maka/pull/2196) on August 8, 2026, and
explicitly removed, together with its unused service and bridge fields, in
[#3610](https://github.com/apache/maka/pull/3610) on August 23, 2026.

The current Trace panel reads a Session-specific projection from the Runtime
Host: usage, context composition, and the turn timeline. It does not expose a
replacement database-path button. The removal commit establishes what changed;
it does not document a broader product rationale for removing path access.

## Save readable conversation text

1. Select the affected task. For a long conversation, load the earlier messages
   you need before exporting: these actions serialize the messages loaded by
   the current interface, rather than querying the complete stored ledger.
2. Open the command palette with **Cmd+K** on macOS or **Ctrl+K** on Windows/Linux.
3. Choose **Save task as an .md file** and select a destination in the save dialog.
   Give that saved file to the assistant investigating the problem. Alternatively,
   **Copy task as Markdown** puts the same representation on the clipboard.

Markdown contains the user messages, assistant answers, and tool names/intents.
It leaves out reasoning, raw tool results, token-usage records, and permission
decisions. It is useful for discussing what happened in the conversation, but
it is not a complete execution trace. User text is kept as entered; assistant
text and tool intents pass through secret redaction. Review the selected
content before sharing it.

## Copy diagnostics for a failure

With the affected task open, choose **Copy diagnostics** in the command palette.
The shortcut is **Cmd+Shift+D** on macOS or **Ctrl+Shift+D** on Windows/Linux.
The report is copied to the clipboard; paste it into a text file or your report.
**Settings → About → Copy diagnostics** is also available for general app issues.

The report includes the Desktop environment, recent main-process logs, and
Runtime Host diagnostics when available. A task-targeted report resolves the
Host for that task; an unavailable Host is reported as unavailable. Reports
apply secret redaction and home-path shortening. They are not full conversation
exports. Include the action that failed, the approximate time, and the relevant
Trace-panel error or screenshot alongside the report.

## Export a portable Session when more state is needed

Builds containing [#5197](https://github.com/apache/maka/pull/5197), merged on
September 12, 2026, also offer **Settings → Import/export tasks → Export tasks**
for the **Local** Host. Choose the task and export a `.maka-session` file. Wait
until the task and its subagents have stopped running; confirm inclusion of
subagent conversations if prompted. This Desktop export surface is not shown
for remote Hosts.

The bundle carries the selected Session, its subagent subtree, and referenced
artifacts/context-offload data. It excludes connection credentials and the
user's project directory. It also intentionally omits diagnostic events such
as provider-request captures, model-call attempts, and stream diagnostics, so
it does not replace the diagnostic report. Conversation and artifact content
can still contain private information.

A `.maka-session` bundle is intended for import into a compatible Maka
installation, not for opening as plain text. Use Markdown for an assistant
that only needs readable conversation text. If the export page is absent on
an older build, use the Markdown and diagnostic commands available there.

## Implementation references

- [Current Trace panel](../apps/desktop/src/renderer/features/workbar/tools/inspector/session-inspector-panel.tsx)
- [Command actions and loaded-message export](../apps/desktop/src/renderer/app-shell-command-actions.ts)
- [Markdown fields and redaction](../apps/desktop/src/renderer/conversation-markdown.ts)
- [Diagnostic collection and formatting](../apps/desktop/src/main/main-process-diagnostics.ts)
- [Local Session export surface](../apps/desktop/src/renderer/features/session-bundle/session-bundle-tasks.tsx)
- [Bundle export contract](../packages/runtime/src/session-export.ts) and [omitted diagnostic events](../packages/storage/src/session-bundle-policy.ts)
