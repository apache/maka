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

# maka-files-native

[简体中文](README.zh-CN.md)

Exposes file operations for an explicitly selected workspace. `provide` registers the service and `attachments` handles captured file resources. The wrapper supplies the original call scope and directory authority to the file engine. File tools and commands share the session sandbox preset: reads may reach outside the workspace; workspace-write permits writes in the workspace and system temporary directories. Other writes require permission approval. The selected directory remains captured, and approvals cannot override workspace metadata or Host-private protections.

`read` returns UTF-8 text pages and image content from workspace files or Session attachments. It also pages original tool-result resources visible to the calling Session. The Read tool uses the permissions of its live Invocation. Each text attachment page loads the complete admitted upload and validates UTF-8 and the absence of NUL bytes before returning a bounded page. Each archive page loads the original model projection, and cancellation waits for that storage operation to settle.

Search calls return complete admitted results; they do not introduce a cursor or replace source authority. Cancellation waits for the original worker, including ignore-file reads. Paged Read and file-resource transfer retain their existing complete continuation and chunk protocols.

[Source](src/lib.rs) · [Cargo manifest](Cargo.toml)
