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

/*
 * Records the configuration file Maka Desktop writes and reads, for the Data
 * page's round-trip tests (crates/settings/src/data_tests.rs).
 *
 * Runs Desktop's own `config:export` and `config:import` handlers
 * (apps/desktop/src/main/runtime-host-config-ipc-main.ts) with its settings
 * module and Runtime Host client over a fake Host, which checks every request
 * and every answer with the protocol's own decoders (`HOST_OPERATION_SPECS`),
 * and writes what they did:
 *
 * - `desktop_export_full.json`, `desktop_export_full.transcript.json`: the file
 *   Desktop exports with all four categories, and the Host requests (with
 *   their answers) it made on the way;
 * - `desktop_export_basic.json` (+ transcript): connections and settings,
 *   Desktop's default selection, so secrets are stripped;
 * - `desktop_export_credentials.json` (+ transcript): credentials alone,
 *   where the proxy password carries its target;
 * - `desktop_import_full.transcript.json`, `desktop_import_credentials.transcript.json`
 *   (+ `.result.json`): what Desktop sends a fresh Host when it imports
 *   those files with "Skip existing", and what it reports;
 * - `desktop_import_overwrite.transcript.json` (+ `.result.json`): the full
 *   file imported with "Overwrite" into a Host that already has a `relay`
 *   (with a key) and a `deepseek` of another provider;
 * - `desktop_export_proxy.json` (+ transcript), `desktop_import_proxy.result.json`:
 *   all four categories from a Host with the proxy's password saved, and
 *   Desktop refusing its own file;
 * - `desktop_import_gpui_<name>.transcript.json` (+ `.result.json`): Desktop
 *   importing `gpui_export_<name>.json`, the files this client writes (the
 *   Data page's tests write them with MAKA_WRITE_CONFIG_FIXTURES=1), when
 *   they are there.
 *
 * The full export's Host has no proxy password saved: Desktop writes a saved
 * one into the settings payload without its target, and its own import then
 * refuses the file ("Proxy password import requires a target binding").
 *
 * Run through scripts/config-transfer-fixtures.sh.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerRuntimeHostConfigIpc } from '@desktop/main/runtime-host-config-ipc-main.ts';
import { createRuntimeHostSettingsModule } from '@desktop/main/runtime-host-settings-ipc-main.ts';
import { DesktopRuntimeHostClient } from '@desktop/main/runtime-host-client.ts';
import { createDefaultSettings } from '@maka/core/settings';
import { HOST_OPERATION_SPECS } from '@maka/runtime-host/protocol';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: config-transfer-fixtures <output directory>');

type Json = any;
type Exchange = { operation: string; input: Json; output: Json };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

/** The Host's policy for a fresh root (the golden fixture), as `revision`. */
function freshPolicy(): Json {
  return {
    networkProxy: {
      enabled: false,
      protocol: 'http',
      host: '127.0.0.1',
      port: 7890,
      authEnabled: false,
      username: '',
      bypassList: ['metaso.cn', 'baidu.com'],
      autoBypassDomains: ['localhost', '127.0.0.1', '::1', '192.168.*', '10.*', '*.local'],
    },
    personalization: { displayName: '', assistantTone: '' },
    memory: { enabled: true, agentReadEnabled: false },
    workspaceInstructions: { enabled: true },
    privacy: { incognitoActive: false },
    chatDefaults: { permissionMode: 'bypass' },
    webSearch: { enabled: false, defaultProvider: 'model' },
    subagents: { presets: [] },
    shell: { preference: 'auto', executable: '' },
    externalAgents: { antigravity: { executable: '' } },
  };
}

interface Entry {
  connectionId: string;
  revision: number;
  slug: string;
  name: string;
  providerType: string;
  baseUrl?: string;
  defaultApiProtocol?: string;
  enabled: boolean;
  modelSource?: string;
  lastTest?: Json;
  requestBodyOverlay?: Json;
  enabledModelIds: string[];
  models: Json[];
  catalogEntries: Json[];
  modelOverrides?: Json;
}

function catalogEntry(id: string, name?: string): Json {
  return {
    id,
    ...(name ? { displayName: name } : {}),
    canUseAsChatDefault: true,
    isDefault: false,
    supportsVision: false,
    thinkingLevels: [],
  };
}

/**
 * A Runtime Host that keeps a connection catalog, a vault, the runtime
 * policy, and MEMORY.md, answering as the real one would; every request and
 * answer passes the protocol's decoders first.
 */
class FakeHost {
  readonly exchanges: Exchange[] = [];
  policyRevision = 1;
  policy: Json = freshPolicy();
  catalogRevision = 1;
  defaultTarget: Json = null;
  connections: Entry[] = [];
  vault = new Map<string, { id: string; revision: number; secret: string; proxyTarget?: Json }>();
  vaultRevision = 1;
  memory = '';
  memoryRevision = 1;
  upload: { id: string; bytes: Buffer[] } | undefined;
  nextId = 1;

  /** A UUID (the ids the Host mints), counted from `prefix`'s digit. */
  id(prefix: string): string {
    const digit = { c: '1', k: '2', u: '3' }[prefix] ?? '9';
    return `0000000${digit}-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
  }

  request(operation: string, input: Json): Json {
    const spec = (HOST_OPERATION_SPECS as Json)[operation];
    if (!spec) throw new Error(`unknown operation ${operation}`);
    spec.decodeInput(clone(input));
    const output = this.answer(operation, input);
    spec.decodeOutput(clone(output));
    this.exchanges.push({ operation, input: clone(input), output: clone(output) });
    return clone(output);
  }

  status(locator: Json): Json {
    const stored = this.vault.get(JSON.stringify(locator));
    return stored
      ? {
          locator,
          configured: true,
          credentialId: stored.id,
          revision: stored.revision,
          updatedAt: 1_790_000_000_000,
        }
      : { locator, configured: false, credentialId: null, revision: null, updatedAt: null };
  }

  answer(operation: string, input: Json): Json {
    switch (operation) {
      case 'runtime.policy.query':
        return { revision: this.policyRevision, policy: clone(this.policy) };
      case 'runtime.policy.mutate': {
        const key = {
          set_jev: 'jev',
          set_network_proxy: 'networkProxy',
          set_personalization: 'personalization',
          set_memory: 'memory',
          set_workspace_instructions: 'workspaceInstructions',
          set_privacy: 'privacy',
          set_chat_defaults: 'chatDefaults',
          set_web_search: 'webSearch',
          set_subagents: 'subagents',
          set_external_agents: 'externalAgents',
          set_shell: 'shell',
        }[input.operation.kind as string];
        if (!key) throw new Error(`unexpected mutation ${input.operation.kind}`);
        this.policy[key] = clone(input.operation.value);
        this.policyRevision += 1;
        return { kind: 'committed', revision: this.policyRevision };
      }
      case 'runtime.policy.network-proxy.update': {
        this.policy.networkProxy = clone(input.networkProxy);
        this.policyRevision += 1;
        const locator = { scope: 'network_proxy', kind: 'password' };
        this.writeCredential(locator, input.credential);
        return {
          kind: 'committed',
          revision: this.policyRevision,
          credentialStatus: this.status(locator),
        };
      }
      case 'credential.vault.query':
        return { kind: 'status', status: this.status(input.locator) };
      case 'credential.vault.set':
        this.writeCredential(input.locator, { kind: 'replace', secret: input.secret });
        return {
          kind: 'committed',
          vaultRevision: this.vaultRevision,
          status: this.status(input.locator),
        };
      case 'configuration.credentials.export': {
        const stored = this.vault.get(JSON.stringify(input.locator));
        if (!stored) return { credential: null };
        return {
          credential: {
            locator: input.locator,
            secretBase64: b64(stored.secret),
            ...(stored.proxyTarget ? { proxyTarget: stored.proxyTarget } : {}),
          },
        };
      }
      case 'connection.catalog.query':
        return this.catalogPage();
      case 'connection.catalog.create': {
        const draft = input.connection;
        const entry: Entry = {
          connectionId: this.id('c'),
          revision: 1,
          slug: draft.slug,
          name: draft.name,
          providerType: draft.providerType,
          ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
          ...(draft.defaultApiProtocol ? { defaultApiProtocol: draft.defaultApiProtocol } : {}),
          enabled: draft.enabled,
          ...(draft.requestBodyOverlay ? { requestBodyOverlay: draft.requestBodyOverlay } : {}),
          enabledModelIds: [...draft.enabledModelIds],
          models: [],
          catalogEntries: draft.enabledModelIds.map((id: string) => catalogEntry(id)),
          ...(draft.modelOverrides ? { modelOverrides: draft.modelOverrides } : {}),
        };
        this.connections.push(entry);
        this.catalogRevision += 1;
        return {
          kind: 'committed',
          catalogRevision: this.catalogRevision,
          connection: { connectionId: entry.connectionId, revision: entry.revision },
        };
      }
      case 'connection.catalog.update': {
        const entry = this.connections.find(
          (item) => item.connectionId === input.expected.connectionId,
        );
        if (!entry || entry.revision !== input.expected.revision) {
          return {
            kind: 'connection_stale',
            expected: input.expected,
            actual: entry ? { connectionId: entry.connectionId, revision: entry.revision } : null,
          };
        }
        const changes = input.changes;
        entry.name = changes.name;
        if (changes.baseUrl === undefined) delete entry.baseUrl;
        else entry.baseUrl = changes.baseUrl;
        entry.enabled = changes.enabled;
        entry.enabledModelIds = [...changes.enabledModelIds];
        for (const id of changes.enabledModelIds) {
          if (!entry.catalogEntries.some((item) => item.id === id)) {
            entry.catalogEntries.push(catalogEntry(id));
          }
        }
        if (changes.modelOverrides === null) delete entry.modelOverrides;
        else if (changes.modelOverrides !== undefined) entry.modelOverrides = changes.modelOverrides;
        if (changes.requestBodyOverlay === null) delete entry.requestBodyOverlay;
        else if (changes.requestBodyOverlay !== undefined) {
          entry.requestBodyOverlay = changes.requestBodyOverlay;
        }
        entry.revision += 1;
        this.catalogRevision += 1;
        return {
          kind: 'committed',
          catalogRevision: this.catalogRevision,
          connection: { connectionId: entry.connectionId, revision: entry.revision },
        };
      }
      case 'connection.catalog.remove': {
        const index = this.connections.findIndex(
          (item) =>
            item.connectionId === input.expected.connectionId &&
            item.revision === input.expected.revision,
        );
        if (index < 0) return { kind: 'connection_stale', expected: input.expected, actual: null };
        this.connections.splice(index, 1);
        this.catalogRevision += 1;
        return { kind: 'committed', catalogRevision: this.catalogRevision };
      }
      case 'memory.query':
        if (input.kind === 'state') return this.memoryState();
        if (input.kind === 'document_start') {
          if (!this.memory) return { kind: 'missing', document: input.document };
          return {
            kind: 'document_page',
            document: input.document,
            revision: this.memoryRevisionId(),
            offset: 0,
            totalBytes: Buffer.byteLength(this.memory),
            chunkBase64: b64(this.memory),
            nextCursor: null,
          };
        }
        throw new Error(`unexpected memory query ${input.kind}`);
      case 'memory.mutate':
        return this.mutateMemory(input);
      default:
        throw new Error(`the fake Host does not answer ${operation}`);
    }
  }

  writeCredential(locator: Json, operation: Json): void {
    const key = JSON.stringify(locator);
    if (operation.kind === 'delete') {
      this.vault.delete(key);
    } else if (operation.kind === 'replace') {
      const current = this.vault.get(key);
      this.vault.set(key, {
        id: current?.id ?? this.id('k'),
        revision: (current?.revision ?? 0) + 1,
        secret: operation.secret,
        ...(locator.scope === 'network_proxy'
          ? {
              proxyTarget: {
                protocol: this.policy.networkProxy.protocol,
                host: this.policy.networkProxy.host.trim().toLowerCase(),
                port: this.policy.networkProxy.port,
                username: this.policy.networkProxy.username,
              },
            }
          : {}),
      });
    } else {
      return;
    }
    this.vaultRevision += 1;
  }

  catalogPage(): Json {
    const items: Json[] = [];
    this.connections.forEach((entry, connectionIndex) => {
      const { enabledModelIds, models, catalogEntries, modelOverrides, ...header } = entry;
      items.push({
        kind: 'connection',
        connectionIndex,
        ...header,
        enabledModelIdCount: enabledModelIds.length,
        modelCount: models.length,
        catalogEntryCount: catalogEntries.length,
      });
      enabledModelIds.forEach((modelId, itemIndex) =>
        items.push({ kind: 'enabled_model_id', connectionIndex, itemIndex, modelId }),
      );
      models.forEach((model, itemIndex) =>
        items.push({ kind: 'model', connectionIndex, itemIndex, model }),
      );
      catalogEntries.forEach((entryItem, itemIndex) =>
        items.push({
          kind: 'catalog_entry',
          connectionIndex,
          itemIndex,
          entry: entryItem,
          ...(modelOverrides?.[entryItem.id] ? { modelOverride: modelOverrides[entryItem.id] } : {}),
        }),
      );
    });
    return {
      kind: 'page',
      revision: this.catalogRevision,
      defaultTarget: this.defaultTarget,
      connectionCount: this.connections.length,
      items,
      nextCursor: null,
    };
  }

  memoryRevisionId(): string {
    return `sha256:${String(this.memoryRevision).padStart(64, '0')}`;
  }

  memoryState(): Json {
    return {
      kind: 'state',
      revision: this.memoryRevisionId(),
      memoryRevision: this.memory ? this.memoryRevisionId() : null,
      pendingRevision: null,
      agentReadEnabled: false,
      status: this.memory ? 'ok' : 'missing',
      entryCount: 0,
      activeEntryCount: 0,
      archivedEntryCount: 0,
      proposalCount: 0,
      backups: [],
    };
  }

  mutateMemory(input: Json): Json {
    switch (input.kind) {
      case 'replace_begin':
        this.upload = { id: this.id('u'), bytes: [] };
        return { kind: 'upload_opened', uploadId: this.upload.id, nextOffset: 0 };
      case 'replace_chunk': {
        const chunk = Buffer.from(input.chunkBase64, 'base64');
        this.upload!.bytes.push(chunk);
        return {
          kind: 'chunk_accepted',
          uploadId: input.uploadId,
          nextOffset: input.offset + chunk.byteLength,
        };
      }
      case 'replace_commit':
        this.memory = Buffer.concat(this.upload!.bytes).toString('utf8');
        this.memoryRevision += 1;
        this.upload = undefined;
        return {
          kind: 'committed',
          revision: this.memoryRevisionId(),
          memoryRevision: this.memoryRevisionId(),
          pendingRevision: null,
        };
      default:
        throw new Error(`unexpected memory mutation ${input.kind}`);
    }
  }
}

const RELAY = '00000001-0000-4000-8000-00000000c001';
const DEEPSEEK = '00000001-0000-4000-8000-00000000c002';

/** A Host with two connections, their keys, a Tavily key (and the proxy's
 * password when `proxyPassword`), a changed policy, and MEMORY.md. */
function furnishedHost(proxyPassword: boolean): FakeHost {
  const host = new FakeHost();
  host.policyRevision = 7;
  host.policy.networkProxy = {
    ...host.policy.networkProxy,
    enabled: true,
    host: 'proxy.example',
    port: 8080,
    authEnabled: true,
    username: 'ada',
  };
  host.policy.personalization = { displayName: 'Ada', assistantTone: 'Brief.' };
  host.policy.privacy = { incognitoActive: true };
  host.policy.chatDefaults = { permissionMode: 'ask', codeModeEnabled: true };
  host.policy.webSearch = { enabled: true, defaultProvider: 'tavily' };
  host.policy.shell = { preference: 'git_bash', executable: 'C:/Git/bin/bash.exe' };
  host.catalogRevision = 5;
  host.connections = [
    {
      connectionId: RELAY,
      revision: 3,
      slug: 'relay',
      name: 'My relay',
      providerType: 'custom',
      baseUrl: 'https://relay.example/v1',
      defaultApiProtocol: 'openai-chat',
      enabled: true,
      modelSource: 'fetched',
      lastTest: { status: 'verified', checkedAt: '2026-09-28T10:00:00.000Z' },
      requestBodyOverlay: { reasoning: { effort: 'low' } },
      enabledModelIds: ['m1'],
      models: [{ id: 'm1', displayName: 'Model one', contextWindow: 128000 }, { id: 'm2' }],
      catalogEntries: [catalogEntry('m1', 'Model one'), catalogEntry('m2')],
      modelOverrides: { m1: { contextWindow: 64000 } },
    },
    {
      connectionId: DEEPSEEK,
      revision: 2,
      slug: 'deepseek',
      name: 'DeepSeek',
      providerType: 'deepseek',
      enabled: false,
      enabledModelIds: ['deepseek-v4-flash'],
      models: [],
      catalogEntries: [catalogEntry('deepseek-v4-flash', 'DeepSeek V4 Flash')],
    },
  ];
  host.defaultTarget = { connectionId: RELAY, modelId: 'm1' };
  const put = (locator: Json, secret: string, proxyTarget?: Json) =>
    host.vault.set(JSON.stringify(locator), {
      id: host.id('k'),
      revision: 1,
      secret,
      ...(proxyTarget ? { proxyTarget } : {}),
    });
  put({ scope: 'connection', connectionId: RELAY, kind: 'api_key' }, 'sk-relay');
  put(
    { scope: 'connection', connectionId: RELAY, kind: 'request_headers' },
    '{"X-Org":"acme"}',
  );
  put({ scope: 'connection', connectionId: DEEPSEEK, kind: 'api_key' }, 'sk-deep');
  if (proxyPassword) {
    put({ scope: 'network_proxy', kind: 'password' }, 'proxy-pw', {
      protocol: 'http',
      host: 'proxy.example',
      port: 8080,
      username: 'ada',
    });
  }
  put({ scope: 'web_search', provider: 'tavily', kind: 'api_key' }, 'tvly-key');
  host.memory = '# Memory\n\n- Prefers tea.\n';
  return host;
}

/** A Host that already has a `relay` (renamed, disabled, with an old key
 * and no model parameters) and a `deepseek` slug on another provider. */
function staleHost(): FakeHost {
  const host = new FakeHost();
  host.catalogRevision = 4;
  const relay = '00000001-0000-4000-8000-0000000000a1';
  host.connections = [
    {
      connectionId: relay,
      revision: 6,
      slug: 'relay',
      name: 'Old relay',
      providerType: 'custom',
      baseUrl: 'https://relay.example/v1',
      defaultApiProtocol: 'openai-chat',
      enabled: false,
      enabledModelIds: ['m0'],
      models: [],
      catalogEntries: [catalogEntry('m0')],
    },
    {
      connectionId: '00000001-0000-4000-8000-0000000000a2',
      revision: 2,
      slug: 'deepseek',
      name: 'Not DeepSeek',
      providerType: 'moonshot',
      enabled: true,
      enabledModelIds: ['kimi-k2'],
      models: [],
      catalogEntries: [catalogEntry('kimi-k2')],
    },
  ];
  host.vault.set(JSON.stringify({ scope: 'connection', connectionId: relay, kind: 'api_key' }), {
    id: host.id('k'),
    revision: 3,
    secret: 'sk-old',
  });
  return host;
}

/** Desktop's config handlers over `host`, with a client settings file of
 * Desktop's defaults. */
function desktop(host: FakeHost, file: string) {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<Json>>();
  const connection = {
    hostEpoch: 'e',
    request: async (operation: string, input: Json) => host.request(operation, input),
  };
  const client = new DesktopRuntimeHostClient(connection as never);
  let local: Json = createDefaultSettings();
  const settingsStore = {
    get: async () => clone(local),
    update: async (patch: Json) => {
      local = { ...local, ...clone(patch) };
      return clone(local);
    },
  };
  const settingsModule = createRuntimeHostSettingsModule({
    client: client as never,
    settingsStore: settingsStore as never,
    applyClientSettings: async () => undefined,
  });
  registerRuntimeHostConfigIpc({
    uiLocale: () => 'en',
    ipcMain: { handle: (channel: string, listener: Json) => handlers.set(channel, listener) },
    client: client as never,
    mainWindowController: {
      showSaveDialog: async () => ({ canceled: false, filePath: file }),
      showOpenDialog: async () => ({ canceled: false, filePaths: [file] }),
    } as never,
    appVersion: '0.2.0-dev.49',
    settingsModule,
    emitConnectionsChanged: () => undefined,
  } as never);
  return handlers;
}

async function exportWith(
  categories: string[],
  name: string,
  dir: string,
  proxyPassword = false,
): Promise<string> {
  const host = furnishedHost(proxyPassword);
  const file = join(dir, `${name}.json`);
  const handlers = desktop(host, file);
  const result = await handlers.get('config:export')!({}, { categories });
  if (!result.ok) throw new Error(`export failed: ${JSON.stringify(result)}`);
  const text = await readFile(file, 'utf8');
  await writeFile(join(OUT, `${name}.json`), text);
  await writeFile(
    join(OUT, `${name}.transcript.json`),
    `${JSON.stringify(host.exchanges, null, 2)}\n`,
  );
  return file;
}

async function main(): Promise<void> {
const dir = await mkdtemp(join(tmpdir(), 'maka-config-transfer-'));
const full = await exportWith(
  ['connections', 'settings', 'memory', 'credentials'],
  'desktop_export_full',
  dir,
);
await exportWith(['connections', 'settings'], 'desktop_export_basic', dir);
const credentials = await exportWith(['credentials'], 'desktop_export_credentials', dir, true);

// The credentials alone go to a Host with the same proxy set up and no
// password saved: Desktop refuses to save a proxy password while the
// target's proxy authentication is off.
for (const [file, name, proxied] of [
  [full, 'desktop_import_full', false],
  [credentials, 'desktop_import_credentials', true],
] as const) {
  const fresh = new FakeHost();
  if (proxied) fresh.policy.networkProxy = clone(furnishedHost(false).policy.networkProxy);
  const handlers = desktop(fresh, file);
  const imported = await handlers.get('config:import')!({}, { strategy: 'skip' });
  if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported)}`);
  await writeFile(
    join(OUT, `${name}.transcript.json`),
    `${JSON.stringify(fresh.exchanges, null, 2)}\n`,
  );
  await writeFile(join(OUT, `${name}.result.json`), `${JSON.stringify(imported.result, null, 2)}\n`);
}

// "Overwrite" into a Host that already has both slugs.
{
  const stale = staleHost();
  const handlers = desktop(stale, full);
  const imported = await handlers.get('config:import')!({}, { strategy: 'overwrite' });
  if (!imported.ok) throw new Error(`import failed: ${JSON.stringify(imported)}`);
  await writeFile(
    join(OUT, 'desktop_import_overwrite.transcript.json'),
    `${JSON.stringify(stale.exchanges, null, 2)}\n`,
  );
  await writeFile(
    join(OUT, 'desktop_import_overwrite.result.json'),
    `${JSON.stringify(imported.result, null, 2)}\n`,
  );
}

// A saved proxy password: Desktop writes it into the settings without its
// target, and refuses the file it wrote.
{
  const proxied = await exportWith(
    ['connections', 'settings', 'memory', 'credentials'],
    'desktop_export_proxy',
    dir,
    true,
  );
  const fresh = new FakeHost();
  const imported = await desktop(fresh, proxied).get('config:import')!({}, { strategy: 'skip' });
  if (imported.ok) throw new Error('Desktop imported its proxy file');
  if (fresh.exchanges.length > 0) throw new Error('Desktop wrote before refusing its proxy file');
  await writeFile(
    join(OUT, 'desktop_import_proxy.result.json'),
    `${JSON.stringify(imported, null, 2)}\n`,
  );
}

// The files this client writes, imported by Desktop into a fresh Host.
for (const name of ['full', 'proxy']) {
  const file = join(OUT, `gpui_export_${name}.json`);
  try {
    await readFile(file);
  } catch {
    console.log(`no ${file} yet: run the Data page's tests with MAKA_WRITE_CONFIG_FIXTURES=1`);
    continue;
  }
  const fresh = new FakeHost();
  const imported = await desktop(fresh, file).get('config:import')!({}, { strategy: 'skip' });
  if (!imported.ok) throw new Error(`Desktop refused ${file}: ${JSON.stringify(imported)}`);
  await writeFile(
    join(OUT, `desktop_import_gpui_${name}.transcript.json`),
    `${JSON.stringify(fresh.exchanges, null, 2)}\n`,
  );
  await writeFile(
    join(OUT, `desktop_import_gpui_${name}.result.json`),
    `${JSON.stringify(imported.result, null, 2)}\n`,
  );
}
console.log(`wrote the fixtures to ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
