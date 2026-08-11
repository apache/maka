import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AppSettings } from '@maka/core/settings';
import type { LlmConnection } from '@maka/core/llm-connections';
import {
  parseConfigBundle,
  serializeConfigBundle,
  type CredentialKind,
} from '@maka/storage';
import { applyConfigImport, gatherConfigExport, type ConfigTransferDeps } from '../config-transfer-service.js';

function conn(slug: string): LlmConnection {
  return {
    slug,
    name: slug,
    providerType: 'deepseek',
    defaultModel: 'deepseek-v4-pro',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function settingsWithSecrets(): AppSettings {
  return {
    theme: 'dark',
    network: { proxy: { host: '127.0.0.1', password: 'proxy-secret' } },
    botChat: { channels: { telegram: { chatId: '42', token: 'bot-secret', appSecret: 'app-secret' } } },
    webSearch: { providers: { tavily: { apiKey: 'tavily-secret' } } },
  } as unknown as AppSettings;
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
  const secretsBySlugKind = new Map<string, string>([['deepseek-main::api_key', 'sk-real-key']]);
  const deps: ConfigTransferDeps = {
    appVersion: '0.1.0',
    connectionStore: {
      list: async () => [conn('deepseek-main')],
      save: async (c) => {
        saved.push(c);
        return c;
      },
    },
    settingsStore: {
      get: async () => settingsWithSecrets(),
      update: async (patch) => {
        updatedSettings.push(patch);
        return patch as unknown as AppSettings;
      },
    },
    credentialStore: {
      getSecret: async (slug, kind) => secretsBySlugKind.get(`${slug}::${kind}`) ?? null,
      setSecret: async (slug, kind, value) => {
        setCreds.push({ slug, kind, value });
      },
    },
    readMemory: async () => '# MEMORY\n- note',
    writeMemory: async (content) => {
      writtenMemory.push(content);
    },
    ...overrides,
  };
  return { deps, saved, updatedSettings, setCreds, writtenMemory };
}

describe('config-transfer-service', () => {
  it('exports only selected categories', async () => {
    const { deps } = makeDeps();
    const bundle = await gatherConfigExport(['connections'], deps);
    assert.deepEqual(bundle.includedData, ['connections']);
    assert.equal(bundle.data.settings, undefined);
    assert.equal(bundle.data.credentials, undefined);
  });

  it('omits (does not blank) settings secrets when credentials are NOT included', async () => {
    // Secret keys must be ABSENT, not '' — mergeSettings deep-merges to the
    // leaf, so an absent key preserves the target machine's existing secret on
    // import, whereas '' would overwrite and wipe it.
    const { deps } = makeDeps();
    const bundle = await gatherConfigExport(['settings'], deps);
    const s = bundle.data.settings as Record<string, any>;
    assert.equal('password' in s.network.proxy, false, 'proxy password key omitted');
    assert.equal('token' in s.botChat.channels.telegram, false, 'bot token key omitted');
    assert.equal('appSecret' in s.botChat.channels.telegram, false, 'bot appSecret key omitted');
    assert.equal('apiKey' in s.webSearch.providers.tavily, false, 'tavily apiKey key omitted');
    // Non-secret fields at every level pass through untouched.
    assert.equal(s.theme, 'dark');
    assert.equal(s.network.proxy.host, '127.0.0.1');
    assert.equal(s.botChat.channels.telegram.chatId, '42');
  });

  it('keeps settings secrets and enumerates credentials when credentials ARE included', async () => {
    const { deps } = makeDeps();
    const bundle = await gatherConfigExport(['settings', 'credentials'], deps);
    const s = bundle.data.settings as Record<string, any>;
    assert.equal(s.network.proxy.password, 'proxy-secret', 'secrets retained alongside credentials');
    assert.deepEqual(bundle.data.credentials, [
      { slug: 'deepseek-main', kind: 'api_key', value: 'sk-real-key' },
    ]);
  });

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

  it('v2 import creates profiles disabled, maps credentials by profileRef and restores enabled after a verified test', async () => {
    const { deps } = makeDeps();
    const profiles: Array<{
      profileId: string;
      revision: number;
      label: string;
      enabled: boolean;
      weight: number;
      primary: boolean;
      credentialConfigured: boolean;
      supportedModels: string[];
    }> = [
      {
        profileId: 'primary',
        revision: 1,
        label: 'primary',
        enabled: true,
        weight: 1,
        primary: true,
        credentialConfigured: true,
        supportedModels: [],
      },
    ];
    const calls: string[] = [];
    let nextProfileId = 900;
    deps.profiles = {
      list: async () => ({
        connectionRevision: 1,
        routingMode: 'legacy_primary',
        readyCandidateCount: 0,
        profiles: [...profiles],
      }),
      create: async (_slug, input) => {
        calls.push(`create:${input.label}`);
        profiles.push({
          profileId: `profile-${nextProfileId}`,
          revision: 1,
          label: input.label,
          enabled: false,
          weight: input.weight,
          primary: false,
          credentialConfigured: false,
          supportedModels: [],
        });
        nextProfileId += 1;
      },
      update: async (_slug, input) => {
        calls.push(`update:${input.profileId}`);
        const target = profiles.find((p) => p.profileId === input.profileId);
        if (target) {
          target.label = input.label ?? target.label;
          target.weight = input.weight ?? target.weight;
          target.revision += 1;
        }
      },
      setEnabled: async (_slug, input) => {
        calls.push(`setEnabled:${input.profileId}:${input.enabled}`);
        const target = profiles.find((p) => p.profileId === input.profileId);
        if (target) target.enabled = input.enabled;
      },
      setRoutingMode: async (_slug, input) => {
        calls.push(`routing:${input.mode}`);
      },
      setCredential: async (_slug, input) => {
        calls.push(`credential:${input.profileId}`);
        const target = profiles.find((p) => p.profileId === input.profileId);
        if (target) target.credentialConfigured = true;
      },
      test: async (_slug, input) => {
        calls.push(`test:${input.profileId}`);
        return { ok: true };
      },
    };
    const bundle = {
      schemaVersion: 2,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'credentials'] as const,
      data: {
        connections: [
          {
            ...conn('imported-v2'),
            credentialProfiles: [
              { profileRef: 'primary', profileId: 'primary', label: 'primary', enabled: true, weight: 1, primary: true },
              { profileRef: 'secondary-0', profileId: 'profile-77', label: 'backup', enabled: true, weight: 20, primary: false },
            ],
            routingMode: 'balanced',
          },
        ],
        credentials: [
          { slug: 'imported-v2', profileRef: 'secondary-0', kind: 'api_key', value: 'sk-backup' },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'skip', deps);

    assert.deepEqual(result.profiles, {
      created: 1,
      updated: 0,
      skipped: 0,
      labelConflicts: [],
      verificationFailed: [],
      restoredEnabled: 2,
      balancedRestored: true,
      balancedPending: false,
    });
    // Created disabled first, then the secret, then BOTH the primary and the
    // secondary are re-tested, then the verified secondary is enabled, then
    // balanced is restored.
    assert.deepEqual(calls, [
      'create:backup',
      'credential:profile-900',
      'test:primary',
      'test:profile-900',
      'setEnabled:profile-900:true',
      'routing:balanced',
    ]);
    assert.deepEqual(result.credentials, { applied: 1, skipped: 0 });
  });

  it('v2 import reports label conflicts and never writes their secrets', async () => {
    const { deps } = makeDeps();
    const profiles: Array<{
      profileId: string;
      revision: number;
      label: string;
      enabled: boolean;
      weight: number;
      primary: boolean;
      credentialConfigured: boolean;
      supportedModels: string[];
    }> = [
      {
        profileId: 'profile-existing',
        revision: 3,
        label: 'backup',
        enabled: false,
        weight: 10,
        primary: false,
        credentialConfigured: true,
        supportedModels: [],
      },
    ];
    const calls: string[] = [];
    deps.profiles = {
      list: async () => ({
        connectionRevision: 1,
        routingMode: 'legacy_primary',
        readyCandidateCount: 0,
        profiles: [...profiles],
      }),
      create: async (_slug, input) => {
        calls.push(`create:${input.label}`);
      },
      update: async (_slug, input) => {
        calls.push(`update:${input.profileId}`);
      },
      setEnabled: async () => {
        calls.push('setEnabled');
      },
      setRoutingMode: async (_slug, input) => {
        calls.push(`routing:${input.mode}`);
      },
      setCredential: async (_slug, input) => {
        calls.push(`credential:${input.profileId}`);
      },
      test: async () => {
        calls.push('test');
        return { ok: true };
      },
    };
    const bundle = {
      schemaVersion: 2,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'credentials'] as const,
      data: {
        connections: [
          {
            ...conn('imported-v2'),
            credentialProfiles: [
              { profileRef: 'secondary-0', profileId: 'profile-77', label: 'backup', enabled: true, weight: 20, primary: false },
            ],
            routingMode: 'legacy_primary',
          },
        ],
        credentials: [
          { slug: 'imported-v2', profileRef: 'secondary-0', kind: 'api_key', value: 'sk-must-not-write' },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'skip', deps);

    // The conflicting label is reported, no profile was created and no secret
    // was written against the existing profile with a different id.
    assert.deepEqual(result.profiles?.labelConflicts, ['imported-v2/backup']);
    assert.deepEqual(result.profiles?.skipped, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(result.credentials, { applied: 0, skipped: 1 });
  });

  it('v2 import overwrites a profile in place only on an exact profile-ID match', async () => {
    const { deps } = makeDeps();
    const profiles: Array<{
      profileId: string;
      revision: number;
      label: string;
      enabled: boolean;
      weight: number;
      primary: boolean;
      credentialConfigured: boolean;
      supportedModels: string[];
    }> = [
      {
        profileId: 'profile-77',
        revision: 2,
        label: 'old-label',
        enabled: false,
        weight: 10,
        primary: false,
        credentialConfigured: true,
        supportedModels: [],
      },
    ];
    const calls: string[] = [];
    deps.profiles = {
      list: async () => ({
        connectionRevision: 1,
        routingMode: 'legacy_primary',
        readyCandidateCount: 0,
        profiles: [...profiles],
      }),
      create: async (_slug, input) => {
        calls.push(`create:${input.label}`);
      },
      update: async (_slug, input) => {
        calls.push(`update:${input.profileId}`);
        const target = profiles.find((p) => p.profileId === input.profileId);
        if (target) {
          target.label = input.label ?? target.label;
          target.weight = input.weight ?? target.weight;
          target.revision += 1;
        }
      },
      setEnabled: async () => {
        calls.push('setEnabled');
      },
      setRoutingMode: async (_slug, input) => {
        calls.push(`routing:${input.mode}`);
      },
      setCredential: async (_slug, input) => {
        calls.push(`credential:${input.profileId}`);
      },
      test: async (_slug, input) => {
        calls.push(`test:${input.profileId}`);
        return { ok: false };
      },
    };
    const bundle = {
      schemaVersion: 2,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'credentials'] as const,
      data: {
        connections: [
          {
            ...conn('imported-v2'),
            credentialProfiles: [
              { profileRef: 'secondary-0', profileId: 'profile-77', label: 'renamed', enabled: true, weight: 40, primary: false },
            ],
            routingMode: 'legacy_primary',
          },
        ],
        credentials: [
          { slug: 'imported-v2', profileRef: 'secondary-0', kind: 'api_key', value: 'sk-in-place' },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'overwrite', deps);

    assert.deepEqual(result.profiles?.updated, 1);
    assert.deepEqual(result.profiles?.created, 0);
    assert.deepEqual(calls, ['update:profile-77', 'credential:profile-77', 'test:profile-77']);
    // The re-test failed -> the profile stays disabled and is reported.
    assert.deepEqual(result.profiles?.verificationFailed, ['imported-v2/renamed']);
    assert.deepEqual(result.profiles?.restoredEnabled, 0);
  });

  it('v2 import keeps balanced off when activation gates no longer hold', async () => {
    const { deps } = makeDeps();
    const profiles: Array<{
      profileId: string;
      revision: number;
      label: string;
      enabled: boolean;
      weight: number;
      primary: boolean;
      credentialConfigured: boolean;
      supportedModels: string[];
    }> = [];
    const calls: string[] = [];
    deps.profiles = {
      list: async () => ({
        connectionRevision: 1,
        routingMode: 'legacy_primary',
        readyCandidateCount: 0,
        profiles: [...profiles],
      }),
      create: async (_slug, input) => {
        profiles.push({
          profileId: 'profile-new',
          revision: 1,
          label: input.label,
          enabled: false,
          weight: input.weight,
          primary: false,
          credentialConfigured: false,
          supportedModels: [],
        });
      },
      update: async () => {
        calls.push('update');
      },
      setEnabled: async () => {
        calls.push('setEnabled');
      },
      setRoutingMode: async (_slug, input) => {
        calls.push(`routing:${input.mode}`);
        throw new Error('balanced_activation_rejected');
      },
      setCredential: async () => {
        calls.push('credential');
      },
      test: async () => {
        calls.push('test');
        return { ok: true };
      },
    };
    const bundle = {
      schemaVersion: 2,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections'] as const,
      data: {
        connections: [
          {
            ...conn('imported-v2'),
            credentialProfiles: [
              { profileRef: 'secondary-0', profileId: 'profile-77', label: 'backup', enabled: true, weight: 20, primary: false },
            ],
            routingMode: 'balanced',
          },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'skip', deps);

    assert.deepEqual(result.profiles?.balancedRestored, false);
    assert.deepEqual(result.profiles?.balancedPending, true);
    assert.ok(calls.includes('routing:balanced'));
  });

  it('v2 overwrite quiesces balanced routing and disables enabled secondaries before replacing credentials', async () => {
    const { deps } = makeDeps();
    const profiles: Array<{
      profileId: string;
      revision: number;
      label: string;
      enabled: boolean;
      weight: number;
      primary: boolean;
      credentialConfigured: boolean;
      supportedModels: string[];
    }> = [
      {
        profileId: 'profile-77',
        revision: 3,
        label: 'backup',
        enabled: true,
        weight: 20,
        primary: false,
        credentialConfigured: true,
        supportedModels: [],
      },
      {
        profileId: 'profile-extra',
        revision: 2,
        label: 'kept-account',
        enabled: true,
        weight: 15,
        primary: false,
        credentialConfigured: true,
        supportedModels: [],
      },
    ];
    const calls: string[] = [];
    deps.profiles = {
      list: async () => ({
        connectionRevision: 5,
        routingMode: 'balanced',
        readyCandidateCount: 1,
        profiles: [...profiles],
      }),
      create: async () => {
        calls.push('create');
      },
      update: async (_slug, input) => {
        calls.push(`update:${input.profileId}`);
        const target = profiles.find((p) => p.profileId === input.profileId);
        if (target) {
          target.label = input.label ?? target.label;
          target.weight = input.weight ?? target.weight;
          target.revision += 1;
        }
      },
      setEnabled: async (_slug, input) => {
        calls.push(`setEnabled:${input.profileId}:${input.enabled}`);
        const target = profiles.find((p) => p.profileId === input.profileId);
        if (target) target.enabled = input.enabled;
      },
      setRoutingMode: async (_slug, input) => {
        calls.push(`routing:${input.mode}`);
      },
      setCredential: async (_slug, input) => {
        calls.push(`credential:${input.profileId}`);
      },
      test: async (_slug, input) => {
        calls.push(`test:${input.profileId}`);
        return { ok: true };
      },
    };
    const bundle = {
      schemaVersion: 2,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'credentials'] as const,
      data: {
        connections: [
          {
            ...conn('deepseek-main'),
            credentialProfiles: [
              { profileRef: 'secondary-0', profileId: 'profile-77', label: 'backup', enabled: true, weight: 40, primary: false },
            ],
            routingMode: 'balanced',
          },
        ],
        credentials: [
          { slug: 'deepseek-main', profileRef: 'secondary-0', kind: 'api_key', value: 'sk-new' },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'overwrite', deps);

    // Quiesce first (balanced -> legacy_primary, BOTH secondaries disabled),
    // then the exact-ID update, credential replacement, re-test, re-enable of
    // the bundle-listed profile, restore of the bundle-absent profile, then
    // balanced restore — never "balanced declared + credentials replaced"
    // and never a silently disabled account.
    assert.deepEqual(calls, [
      'routing:legacy_primary',
      'setEnabled:profile-77:false',
      'setEnabled:profile-extra:false',
      'update:profile-77',
      'credential:profile-77',
      'test:profile-77',
      'setEnabled:profile-77:true',
      'setEnabled:profile-extra:true',
      'routing:balanced',
    ]);
    assert.deepEqual(result.profiles?.balancedRestored, true);
    assert.deepEqual(result.profiles?.restoredEnabled, 2);
  });

  it('v2 overwrite keeps a profile disabled when the bundle explicitly disabled it', async () => {
    const { deps } = makeDeps();
    const profiles: Array<{
      profileId: string;
      revision: number;
      label: string;
      enabled: boolean;
      weight: number;
      primary: boolean;
      credentialConfigured: boolean;
      supportedModels: string[];
    }> = [
      {
        profileId: 'profile-77',
        revision: 3,
        label: 'backup',
        enabled: true,
        weight: 20,
        primary: false,
        credentialConfigured: true,
        supportedModels: [],
      },
    ];
    const calls: string[] = [];
    deps.profiles = {
      list: async () => ({
        connectionRevision: 5,
        routingMode: 'balanced',
        readyCandidateCount: 1,
        profiles: [...profiles],
      }),
      create: async () => {
        calls.push('create');
      },
      update: async (_slug, input) => {
        calls.push(`update:${input.profileId}`);
        const target = profiles.find((p) => p.profileId === input.profileId);
        if (target) {
          target.label = input.label ?? target.label;
          target.weight = input.weight ?? target.weight;
          target.revision += 1;
        }
      },
      setEnabled: async (_slug, input) => {
        calls.push(`setEnabled:${input.profileId}:${input.enabled}`);
        const target = profiles.find((p) => p.profileId === input.profileId);
        if (target) target.enabled = input.enabled;
      },
      setRoutingMode: async (_slug, input) => {
        calls.push(`routing:${input.mode}`);
      },
      setCredential: async (_slug, input) => {
        calls.push(`credential:${input.profileId}`);
      },
      test: async (_slug, input) => {
        calls.push(`test:${input.profileId}`);
        return { ok: true };
      },
    };
    const bundle = {
      schemaVersion: 2,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections'] as const,
      data: {
        connections: [
          {
            ...conn('deepseek-main'),
            credentialProfiles: [
              { profileRef: 'secondary-0', profileId: 'profile-77', label: 'backup', enabled: false, weight: 20, primary: false },
            ],
            routingMode: 'legacy_primary',
          },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'overwrite', deps);

    // The bundle claimed profile-77 with enabled=false: the quiesce disable
    // must NOT be undone — only the bundle's own state rules apply.
    assert.deepEqual(calls, [
      'routing:legacy_primary',
      'setEnabled:profile-77:false',
      'update:profile-77',
    ]);
    assert.deepEqual(result.profiles?.restoredEnabled, 0);
    assert.deepEqual(result.profiles?.verificationFailed, []);
  });

  it('v2 overwrite keeps a profile disabled when re-verification fails', async () => {
    const { deps } = makeDeps();
    const profiles: Array<{
      profileId: string;
      revision: number;
      label: string;
      enabled: boolean;
      weight: number;
      primary: boolean;
      credentialConfigured: boolean;
      supportedModels: string[];
    }> = [
      {
        profileId: 'profile-77',
        revision: 3,
        label: 'backup',
        enabled: true,
        weight: 20,
        primary: false,
        credentialConfigured: true,
        supportedModels: [],
      },
    ];
    const calls: string[] = [];
    deps.profiles = {
      list: async () => ({
        connectionRevision: 5,
        routingMode: 'legacy_primary',
        readyCandidateCount: 0,
        profiles: [...profiles],
      }),
      create: async () => {
        calls.push('create');
      },
      update: async (_slug, input) => {
        calls.push(`update:${input.profileId}`);
        const target = profiles.find((p) => p.profileId === input.profileId);
        if (target) {
          target.label = input.label ?? target.label;
          target.weight = input.weight ?? target.weight;
          target.revision += 1;
        }
      },
      setEnabled: async (_slug, input) => {
        calls.push(`setEnabled:${input.profileId}:${input.enabled}`);
        const target = profiles.find((p) => p.profileId === input.profileId);
        if (target) target.enabled = input.enabled;
      },
      setRoutingMode: async (_slug, input) => {
        calls.push(`routing:${input.mode}`);
      },
      setCredential: async (_slug, input) => {
        calls.push(`credential:${input.profileId}`);
      },
      test: async (_slug, input) => {
        calls.push(`test:${input.profileId}`);
        return { ok: false };
      },
    };
    const bundle = {
      schemaVersion: 2,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections'] as const,
      data: {
        connections: [
          {
            ...conn('deepseek-main'),
            credentialProfiles: [
              { profileRef: 'secondary-0', profileId: 'profile-77', label: 'backup', enabled: true, weight: 20, primary: false },
            ],
            routingMode: 'legacy_primary',
          },
        ],
      },
    };

    const result = await applyConfigImport(bundle as any, 'overwrite', deps);

    // The re-test failed: fail-closed — the profile stays disabled and is
    // reported, never silently re-enabled by the quiesce restore.
    assert.deepEqual(calls, [
      'setEnabled:profile-77:false',
      'update:profile-77',
      'test:profile-77',
    ]);
    assert.deepEqual(result.profiles?.restoredEnabled, 0);
    assert.deepEqual(result.profiles?.verificationFailed, ['deepseek-main/backup']);
  });

  it('routes a parsed v1 bundle through the legacy import path', async () => {
    const { deps, setCreds } = makeDeps();
    const raw = serializeConfigBundle({
      schemaVersion: 1,
      exportedAt: '',
      appVersion: '0.1.0',
      includedData: ['connections', 'credentials'] as const,
      data: {
        connections: [conn('brand-new')],
        credentials: [{ slug: 'brand-new', kind: 'api_key', value: 'sk-v1' }],
      },
    });
    const parsed = parseConfigBundle(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    // The parser must preserve the SOURCE version: a v1 file must never be
    // rewritten into the v2 profile-aware import path.
    assert.equal(parsed.bundle.schemaVersion, 1);
    const result = await applyConfigImport(parsed.bundle, 'skip', deps);
    assert.deepEqual(result.credentials, { applied: 1, skipped: 0 });
    assert.equal(result.profiles, undefined, 'legacy import must not touch profiles');
    assert.deepEqual(setCreds, [{ slug: 'brand-new', kind: 'api_key', value: 'sk-v1' }]);
  });
});
