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

# Feishu Source

Read-only Source plugin for memory-network. Requires the Host `sources` service.

Configure a stable account/tenant `instanceId`, explicit `containers` (a JSON string containing an array of `chat`/`thread` objects with native IDs; the host configuration surface accepts scalar fields), and `startTime` (Unix seconds). Optional `endTime` freezes an upper boundary; otherwise each enumeration fixes its upper bound at scan start. Do not reuse an instance ID for a different account or tenant.

Provide an existing authorized user/tenant access token through plugin credential slot `access-token`, or an absolute `tokenFile` with owner-only permissions. Tokens never enter tools, indexes or references. Token acquisition/refresh is currently managed by the caller. A signed-in desktop app is not an Open Platform credential.

The adapter enumerates metadata, follows thread replies, resolves messages on demand, preserves original fields and revisions, and checks current access before returning cached evidence. The API may transfer content during listing/permission checks; memory persists addresses, not a bulk body mirror. Only actually read evidence is cached. To find recent replies on older roots, chat enumeration also visits older roots without retaining their bodies. Index maintenance currently uses scoped rescans to compare metadata revisions, not event subscriptions. Search reads one provider page and returns `next`; empty filtered pages can still have successors. Paging cursors expire on plugin reload and are distinct from durable index coverage cursors.

Official API contracts:
- https://open.feishu.cn/document/server-docs/im-v1/message/list
- https://open.feishu.cn/document/server-docs/im-v1/message/get

No send/edit/delete APIs. Unavailable and permission errors fail closed; they do not mean deletion or completed coverage.

`npm run verify` builds, tests and packages. Build memory-network `prepare:test` first for the package helper. Mock HTTP tests do not establish real account authorization.
