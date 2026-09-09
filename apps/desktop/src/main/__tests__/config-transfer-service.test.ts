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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { CredentialKind } from '@maka/storage/credential-store';
import { applyConfigImport, type ConfigTransferDeps } from '../config-transfer-service.js';

function conn(
  slug: string,
  overrides: Partial<LlmConnection> = {},
): LlmConnection {
  return {
    slug,
    name: slug,
    providerType: 'deepseek',
    defaultModel: 'deepseek-v4-pro',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ConfigTransferDeps> = {}): {
  deps: ConfigTransferDeps;
  saved: LlmConnection[];
  updatedSettings: unknown[];
  setCreds: Array<{ slug: string; kind: CredentialKind; value: string }>;
  writtenMemory: string[];
} {
  const saved: LlmConnection[] = [];
  const updatedSettings: unknown[] = [];
  const setCreds: Array<{ slug: string; kind: CredentialKind; value: string }> = [];
  const writtenMemory: string[] = [];
  const deps: ConfigTransferDeps = {
    connectionStore: {
      list: async () => [conn('deepseek-main')],
      save: async (c) => {
        saved.push(c);
        return c;
      },
    },
    settingsStore: {
      update: async (patch) => {
        updatedSettings.push(patch);
        return { skippedCredentials: 0 };
      },
    },
    credentialStore: {
      setSecret: async ({ slug, kind, value }) => {
        setCreds.push({ slug, kind, value });
        return true;
      },
    },
    writeMemory: async (content) => {
      writtenMemory.push(content);
    },
    ...overrides,
  };
  return { deps, saved, updatedSettings, setCreds, writtenMemory };
}

describe('config-transfer-service', () => {
  it('applies an imported bundle to the stores and summarizes', async () => {
    const { deps, saved, updatedSettings, setCreds, writtenMemory } = makeDeps();
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'settings', 'credentials', 'memory'] as const,
      data: {
        connections: [conn('deepseek-main'), conn('brand-new')],
        settings: { theme: 'light' },
        credentials: [{ slug: 'brand-new', kind: 'api_key', value: 'sk-imported' }],
        memory: '# imported memory',
      },
    };
    const result = await applyConfigImport(bundle as any, 'skip', deps);
    // deepseek-main exists -> skipped; brand-new -> created
    assert.deepEqual(result.connections, { created: 1, overwritten: 0, skipped: 1 });
    assert.deepEqual(saved.map((c) => c.slug), ['brand-new']);
    assert.equal(result.settings?.applied, true);
    assert.equal(updatedSettings.length, 1);
    assert.deepEqual(setCreds, [{ slug: 'brand-new', kind: 'api_key', value: 'sk-imported' }]);
    assert.deepEqual(result.credentials, { applied: 1, skipped: 0 });
    assert.deepEqual(writtenMemory, ['# imported memory']);
  });

  it('canonicalizes a legacy zh preference before the imported settings reach observers', async () => {
    const { deps, updatedSettings } = makeDeps();
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['settings'] as const,
      data: {
        settings: {
          personalization: { uiLocale: 'zh', displayName: 'Maka user' },
        },
      },
    };

    await applyConfigImport(bundle as any, 'skip', deps);

    assert.deepEqual(updatedSettings, [
      { personalization: { uiLocale: 'zh-CN', displayName: 'Maka user' } },
    ]);
  });

  it('reports a settings-carried proxy credential skipped by Host target binding', async () => {
    const { deps } = makeDeps({
      settingsStore: {
        update: async () => ({ skippedCredentials: 1 }),
      },
    } as never);
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['settings', 'credentials'] as const,
      data: {
        settings: { network: { proxy: { credential: { kind: 'replace', secret: 'source' } } } },
        credentials: [],
      },
    };

    const result = await applyConfigImport(bundle as any, 'skip', deps);

    assert.deepEqual(result.credentials, { applied: 0, skipped: 1 });
  });

  it('restores the selection a backup states instead of re-enabling its default', async () => {
    // A backup can hold a connection whose default model the user had disabled.
    // `save()` cannot tell a stated selection from one a sync echoed back, so it
    // applies the read-time shim and merges the default in — the import would
    // otherwise quietly re-enable a model the backup had turned off.
    const { deps, saved } = makeDeps();
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections'] as const,
      data: {
        connections: [
          { ...conn('brand-new'), defaultModel: 'disabled-by-user', enabledModelIds: ['kept'] },
        ],
      },
    };

    await applyConfigImport(bundle as any, 'skip', deps);

    assert.deepEqual(saved[0]?.enabledModelIds, ['kept']);
    assert.equal(saved[0]?.defaultModel, '');
  });

  it('does NOT write credentials for a connection the user skipped', async () => {
    // `deepseek-main` already exists on the target; with strategy=skip the
    // connection is not written, so its stored secret must stay untouched.
    const { deps, saved, setCreds } = makeDeps();
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'credentials'] as const,
      data: {
        connections: [conn('deepseek-main')],
        credentials: [{ slug: 'deepseek-main', kind: 'api_key', value: 'sk-should-not-write' }],
      },
    };
    const result = await applyConfigImport(bundle as any, 'skip', deps);
    assert.equal(saved.length, 0, 'existing connection is skipped');
    assert.deepEqual(setCreds, [], 'skipped connection keeps its existing secret');
    assert.deepEqual(result.credentials, { applied: 0, skipped: 1 });
  });

  it('writes credentials for a connection that was overwritten', async () => {
    const { deps, setCreds } = makeDeps();
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'credentials'] as const,
      data: {
        connections: [conn('deepseek-main')],
        credentials: [{ slug: 'deepseek-main', kind: 'api_key', value: 'sk-new' }],
      },
    };
    const result = await applyConfigImport(bundle as any, 'overwrite', deps);
    assert.deepEqual(setCreds, [{ slug: 'deepseek-main', kind: 'api_key', value: 'sk-new' }]);
    assert.deepEqual(result.credentials, { applied: 1, skipped: 0 });
  });

  it('reports a Host-bound connection credential write that loses its target race', async () => {
    const { deps, setCreds } = makeDeps({
      credentialStore: {
        setSecret: async () => false,
      },
    } as never);
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'credentials'] as const,
      data: {
        connections: [conn('deepseek-main')],
        credentials: [{ slug: 'deepseek-main', kind: 'api_key', value: 'source-secret' }],
      },
    };

    const result = await applyConfigImport(bundle as any, 'overwrite', deps);

    assert.deepEqual(setCreds, []);
    assert.deepEqual(result.credentials, { applied: 0, skipped: 1 });
  });

  it('writes a credentials-only bundle to an existing connection', async () => {
    const { deps, saved, setCreds } = makeDeps();
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['credentials'] as const,
      data: {
        credentials: [
          {
            slug: 'deepseek-main',
            kind: 'api_key',
            value: 'sk-restored',
            connection: {
              providerType: 'deepseek',
              effectiveBaseUrl: 'https://api.deepseek.com',
            },
          },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'skip', deps);

    assert.deepEqual(saved, [], 'credentials-only import does not rewrite the connection');
    assert.deepEqual(setCreds, [
      { slug: 'deepseek-main', kind: 'api_key', value: 'sk-restored' },
    ]);
    assert.deepEqual(result.credentials, { applied: 1, skipped: 0 });
  });

  it('skips a credentials-only entry without a source connection binding', async () => {
    const { deps, setCreds } = makeDeps();
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['credentials'] as const,
      data: {
        credentials: [
          {
            slug: 'deepseek-main',
            kind: 'api_key',
            value: 'sk-unbound-source',
          },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'skip', deps);

    assert.deepEqual(setCreds, []);
    assert.deepEqual(result.credentials, { applied: 0, skipped: 1 });
  });

  it('skips a credentials-only entry when the target slug belongs to another provider', async () => {
    const { deps, setCreds } = makeDeps();
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['credentials'] as const,
      data: {
        credentials: [
          {
            slug: 'deepseek-main',
            kind: 'api_key',
            value: 'sk-openai-source',
            connection: {
              providerType: 'openai',
              effectiveBaseUrl: 'https://api.openai.com/v1',
            },
          },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'skip', deps);

    assert.deepEqual(setCreds, []);
    assert.deepEqual(result.credentials, { applied: 0, skipped: 1 });
  });

  it('skips a credentials-only entry when the target endpoint differs', async () => {
    const target = conn('deepseek-main', {
      baseUrl: 'https://target-relay.example/v1',
    });
    const { deps, setCreds } = makeDeps({
      connectionStore: {
        list: async () => [target],
        save: async (connection) => connection,
      },
    });
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['credentials'] as const,
      data: {
        credentials: [
          {
            slug: 'deepseek-main',
            kind: 'api_key',
            value: 'sk-source-endpoint',
            connection: {
              providerType: 'deepseek',
              effectiveBaseUrl: 'https://api.deepseek.com',
            },
          },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'skip', deps);

    assert.deepEqual(setCreds, []);
    assert.deepEqual(result.credentials, { applied: 0, skipped: 1 });
  });

  it('restores the whole bundle when it carries a retained retired connection', async () => {
    // A backup taken before the retirement still lists the connection, and the
    // catalog refuses to create one. Before this was planned as skipped, the
    // refusal threw mid-import: a fresh profile got whichever connections
    // happened to be saved first and no settings, credentials, or memory at
    // all. The live connection is ordered first here on purpose, so a restored
    // abort would look like a partial success rather than a clean failure.
    const { deps, saved, setCreds, writtenMemory, updatedSettings } = makeDeps({
      connectionStore: {
        list: async () => [],
        save: async (c) => {
          if (c.providerType === 'claude-subscription') {
            throw new Error('"claude-subscription" is retired and cannot be added');
          }
          saved.push(c);
          return c;
        },
      },
    });
    const bundle = {
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'settings', 'credentials', 'memory'] as const,
      data: {
        connections: [
          conn('deepseek-main'),
          { ...conn('claude-subscription'), providerType: 'claude-subscription' },
        ],
        settings: { theme: 'light' },
        credentials: [
          { slug: 'deepseek-main', kind: 'api_key', value: 'sk-live' },
          { slug: 'claude-subscription', kind: 'oauth_token', value: 'retired-secret' },
        ],
        memory: '# imported memory',
      },
    };

    const result = await applyConfigImport(bundle as any, 'skip', deps);

    assert.deepEqual(result.connections, { created: 1, overwritten: 0, skipped: 1 });
    assert.deepEqual(saved.map((c) => c.slug), ['deepseek-main']);
    // The rest of the bundle still lands — the point of the whole fix.
    assert.equal(result.settings?.applied, true);
    assert.equal(updatedSettings.length, 1);
    assert.deepEqual(writtenMemory, ['# imported memory']);
    // The retired connection's secret is skipped with it: only a created or
    // overwritten slug gets one written.
    assert.deepEqual(setCreds, [{ slug: 'deepseek-main', kind: 'api_key', value: 'sk-live' }]);
    assert.deepEqual(result.credentials, { applied: 1, skipped: 1 });
  });
});
