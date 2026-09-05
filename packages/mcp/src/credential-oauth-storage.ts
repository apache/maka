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

// packages/mcp/src/credential-oauth-storage.ts
//
// Backs MCP OAuth persistence with the app's shared credential store: one
// `mcp:<serverId>` slug per server, the whole record as one JSON secret.
// Tokens therefore live in credentials.json (0600, workspace root) beside
// every other secret in the app — never in mcp.json, which is the shareable
// config file.
//
// Lives HERE, not in the Electron app: it has no Electron dependency, and
// every process that constructs an McpClientManager over the same mcp.json
// (Desktop main, the CLI capability provider) must be able to read the
// credentials Desktop wrote — a manager without oauthStorage silently
// reports pendingAuthorization()=undefined and erases nothing on
// forgetServerCredentials.

import type { McpOAuthRecord, McpOAuthStorage } from './oauth.js';

/** The slice of @maka/storage's CredentialStore this adapter needs, stated
 * structurally so @maka/mcp does not depend on @maka/storage. */
export interface McpCredentialSecretStore {
  getSecret(slug: string, kind: 'oauth_token'): Promise<string | null>;
  setSecret(slug: string, kind: 'oauth_token', value: string): Promise<void>;
  deleteSecret(slug: string, kind?: 'oauth_token'): Promise<void>;
  compareAndSetSecret?(
    slug: string,
    kind: 'oauth_token',
    expected: string | null,
    value: string,
  ): Promise<{ committed: true } | { committed: false; current: string | null }>;
}

const KIND = 'oauth_token' as const;

export function createCredentialMcpOAuthStorage(store: McpCredentialSecretStore): McpOAuthStorage {
  return {
    async get(serverId) {
      const raw = await store.getSecret(slug(serverId), KIND);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as McpOAuthRecord;
      } catch {
        // A corrupt record is indistinguishable from none: the user
        // re-authorizes, and the next save overwrites it.
        return undefined;
      }
    },
    async set(serverId, record) {
      await store.setSecret(slug(serverId), KIND, JSON.stringify(record));
    },
    async delete(serverId) {
      await store.deleteSecret(slug(serverId), KIND);
    },
    // Maps the coordinator's version-keyed CAS onto the CredentialStore's
    // raw compare-and-set, so a writer outside this process (another Maka
    // instance, a hand edit) trips a conflict instead of being clobbered.
    ...(store.compareAndSetSecret
      ? {
          async compareAndSet(
            serverId: string,
            expectedVersion: number | null,
            record: McpOAuthRecord,
          ): Promise<'committed' | 'conflict' | 'gone'> {
            const raw = await store.getSecret(slug(serverId), KIND);
            const basis = raw === null ? undefined : parseRecord(raw);
            if ((basis?.version ?? null) !== expectedVersion) return 'conflict';
            const result = await store.compareAndSetSecret?.(
              slug(serverId),
              KIND,
              raw,
              JSON.stringify(record),
            );
            if (!result) return 'conflict';
            if (result.committed) return 'committed';
            return result.current === null ? 'gone' : 'conflict';
          },
        }
      : {}),
  };
}

function parseRecord(raw: string): McpOAuthRecord | undefined {
  try {
    return JSON.parse(raw) as McpOAuthRecord;
  } catch {
    return undefined;
  }
}

function slug(serverId: string): string {
  return `mcp:${serverId}`;
}
