/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Node-only helper for turning an MCP server/tool identity into a wire-safe
 * capability entity id.
 *
 * This lives outside `protocol/` on purpose: `clientCapabilityEntityId` uses
 * `node:crypto`, and the protocol barrel is re-exported by the Desktop
 * renderer's startup graph. A value import from the barrel evaluates every
 * `export *` module in the browser, so a Node builtin anywhere in that
 * closure silently breaks `vite dev`. Keeping the hashing helper in its own
 * Node-only module — the same shape as `profile-kind` — lets the renderer keep
 * importing browser-safe values from the barrel without ever loading this one.
 */

import { createHash } from 'node:crypto';

export function clientCapabilityEntityId(value: string, maxLength = 128): string {
  if (/^[A-Za-z0-9_-]+$/u.test(value) && value.length <= maxLength) return value;
  const label = value.replace(/[^A-Za-z0-9_-]+/gu, '_').slice(0, maxLength - 25) || 'mcp';
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 24);
  return `${label}_${digest}`;
}
