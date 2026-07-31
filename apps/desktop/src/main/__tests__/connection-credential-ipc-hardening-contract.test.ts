import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSourceSync } from './main-process-contract-source-helpers.js';

const mainSource = readMainProcessCombinedSourceSync();
const discoveryService =
  mainSource.match(
    /export async function discoverConnectionModels\([\s\S]*?\n\}/,
  )?.[0] ?? '';

function handlerBlock(channel: string): string {
  const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
  assert.notEqual(start, -1, `${channel} handler must exist`);
  const next = mainSource.indexOf('ipcMain.handle(', start + 1);
  return mainSource.slice(start, next === -1 ? undefined : next);
}

describe('connection credential IPC hardening contract', () => {
  it('defines shared fail-closed slug and apiKey IPC validators', () => {
    assert.match(mainSource, /const IPC_CONNECTION_SLUG_MAX_LENGTH = 64;/);
    assert.match(mainSource, /const IPC_CONNECTION_SECRET_MAX_LENGTH = 4096;/);
    assert.match(mainSource, /const IPC_CONTROL_CHARACTER_PATTERN = \/\[\\u0000-\\u001F\\u007F\]\//);
    assert.match(mainSource, /const IPC_CONNECTION_SLUG_PATTERN = \/\^\[A-Za-z0-9\._-\]\+\$\//);
    assert.match(
      mainSource,
      /function normalizeConnectionSlugForIpc\(value: unknown, label: string\): string \{[\s\S]*typeof value !== 'string'[\s\S]*value\.length === 0[\s\S]*value\.length > IPC_CONNECTION_SLUG_MAX_LENGTH[\s\S]*!IPC_CONNECTION_SLUG_PATTERN\.test\(value\) \|\| IPC_CONTROL_CHARACTER_PATTERN\.test\(value\)[\s\S]*return value;/,
    );
    assert.match(
      mainSource,
      /function normalizeConnectionApiKeyForIpc\(value: unknown, label: string\): string \{[\s\S]*typeof value !== 'string'[\s\S]*value\.length > IPC_CONNECTION_SECRET_MAX_LENGTH[\s\S]*IPC_CONTROL_CHARACTER_PATTERN\.test\(value\)[\s\S]*return value;/,
    );
  });

  it('rejects unsafe slug classes while preserving representative existing valid slugs', () => {
    assert.match(mainSource, /const IPC_CONNECTION_SLUG_MAX_LENGTH = 64;/);
    assert.match(mainSource, /const IPC_CONNECTION_SLUG_PATTERN = \/\^\[A-Za-z0-9\._-\]\+\$\//);
    assert.match(mainSource, /const IPC_CONTROL_CHARACTER_PATTERN = \/\[\\u0000-\\u001F\\u007F\]\//);
    assert.match(mainSource, /value\.length === 0/);
    assert.match(mainSource, /value\.length > IPC_CONNECTION_SLUG_MAX_LENGTH/);
    assert.match(mainSource, /IPC_CONTROL_CHARACTER_PATTERN\.test\(value\)/);

    const helper = mainSource.match(/function normalizeConnectionSlugForIpc\(value: unknown, label: string\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(helper, 'normalizeConnectionSlugForIpc helper must exist');
    assert.match(helper, /IPC_CONNECTION_SLUG_PATTERN\.test\(value\)/, 'slug validator must reject whitespace, path separators, and colon via an allowlist');
    assert.match(
      helper,
      /(^|[^\w])\.\.(?!\.)|includes\('\\.\\.'\)|includes\("\.\."\)|traversal|path traversal/i,
      'slug validator must explicitly reject traversal-looking ".." slugs even though dots are otherwise allowed for compatibility',
    );
    for (const validSlug of ['claude-subscription', 'openai-codex', 'zai-coding-plan', 'env-openai']) {
      assert.doesNotMatch(validSlug, /[\u0000-\u001F\u007F/:\\]/, `${validSlug} should stay representative-valid`);
      assert.ok(validSlug.length <= 64, `${validSlug} should stay under the IPC slug cap`);
    }
  });

  it('normalizes create slug and apiKey before store or credential writes', () => {
    const helper = mainSource.match(/function normalizeCreateConnectionInput\(input: CreateConnectionInput\): CreateConnectionInput \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(helper, /normalizeConnectionApiKeyForIpc\(input\.apiKey, 'apiKey'\)/);
    assert.match(helper, /normalizeConnectionSlugForIpc\(input\.slug, 'connection slug'\)/);

    const handler = handlerBlock('connections:create');
    assert.match(handler, /const normalizedInput = normalizeCreateConnectionInput\(input\);[\s\S]*createConnectionWithCredential\(\{ connectionStore, credentialStore \}, normalizedInput\)/);
    assert.match(mainSource, /createConnectionWithCredential[\s\S]*connectionStore\.create\(input\)[\s\S]*credentialStore\.setSecret\(connection\.slug, 'api_key', input\.apiKey\)/);
  });

  it('caps and validates create apiKey before persistence without echoing the secret value', () => {
    const apiKeyHelper = mainSource.match(/function normalizeConnectionApiKeyForIpc\(value: unknown, label: string\): string \{[\s\S]*?\n\}/)?.[0] ?? '';
    const createHelper = mainSource.match(/function normalizeCreateConnectionInput\(input: CreateConnectionInput\): CreateConnectionInput \{[\s\S]*?\n\}/)?.[0] ?? '';
    const handler = handlerBlock('connections:create');

    assert.match(apiKeyHelper, /value\.length > IPC_CONNECTION_SECRET_MAX_LENGTH/);
    assert.match(apiKeyHelper, /IPC_CONTROL_CHARACTER_PATTERN\.test\(value\)/);
    assert.doesNotMatch(apiKeyHelper, /String\(value\)|\$\{value\}|value\}/, 'apiKey validation errors must not echo cleartext secret values');
    assert.ok(
      createHelper.indexOf('normalizeConnectionApiKeyForIpc(input.apiKey, \'apiKey\')')
        < createHelper.indexOf('normalizeConnectionSlugForIpc(input.slug, \'connection slug\')'),
      'create must validate apiKey before constructing normalized input for persistence',
    );
    assert.ok(
      handler.indexOf('normalizeCreateConnectionInput(input)')
        < handler.indexOf('createConnectionWithCredential'),
      'create must normalize and cap apiKey before connection persistence',
    );
    assert.ok(
      handler.indexOf('normalizeCreateConnectionInput(input)')
        < handler.indexOf('createConnectionWithCredential'),
      'create must normalize and cap apiKey before credential persistence',
    );
  });

  it('normalizes update slug and apiKey before side-effecting update or credential writes', () => {
    const helper = mainSource.match(/async function normalizeUpdateConnectionInput\([\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(helper, /const normalizedPatch = normalizeConnectionPatchSecretsForIpc\(patch\);[\s\S]*const existing = await connectionStore\.get\(slug\);/);

    const handler = handlerBlock('connections:update');
    assert.match(handler, /slug = normalizeConnectionSlugForIpc\(slug, 'connection slug'\);/);
    assert.match(handler, /const normalizedPatch = await normalizeUpdateConnectionInput\(deps, slug, patch\);/);
    assert.match(handler, /connectionStore\.update\(slug, normalizedPatch\)/);
    assert.match(handler, /credentialStore\.(?:setSecret|deleteSecret)\(slug, 'api_key'/);
  });

  it('validates renderer-controlled slug handlers before store, credential, or provider work', () => {
    for (const channel of [
      'connections:setDefault',
      'connections:delete',
      'connections:test',
      'connections:fetchModels',
    ]) {
      const handler = handlerBlock(channel);
      const normalizeAt = handler.indexOf('normalizeConnectionSlugForIpc');
      assert.notEqual(normalizeAt, -1, `${channel} must normalize slug`);
      for (const sideEffect of [
        'connectionStore.',
        'credentialStore.',
        'resolveConnectionSecret(',
        'testConnection(',
        'fetchProviderModels(',
        'discoverConnectionModels(',
      ]) {
        const sideEffectAt = handler.indexOf(sideEffect);
        if (sideEffectAt !== -1) {
          assert.ok(normalizeAt < sideEffectAt, `${channel} must normalize before ${sideEffect}`);
        }
      }
    }

    const hasSecret = handlerBlock('connections:hasSecret');
    assert.match(
      hasSecret,
      /slug = normalizeConnectionSlugForIpc\(slug, 'connection slug'\);[\s\S]*const connection = await connectionStore\.get\(slug\);[\s\S]*return hasConnectionSecret\(connection\);/,
    );
    assert.doesNotMatch(
      hasSecret,
      /resolveConnectionSecret\(/,
      'hasSecret is a read-only status probe: it must never call the network-refreshing resolveConnectionSecret',
    );
  });

  it('preserves update apiKey clearing semantics while rejecting invalid provided strings', () => {
    const helper = mainSource.match(/function normalizeConnectionPatchSecretsForIpc\(patch: UpdateConnectionInput\): UpdateConnectionInput \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(helper, /if \(!Object\.prototype\.hasOwnProperty\.call\(patch, 'apiKey'\)\) return patch;/);
    assert.match(helper, /if \(patch\.apiKey === undefined\) return patch;/);
    assert.match(helper, /apiKey: normalizeConnectionApiKeyForIpc\(patch\.apiKey, 'apiKey'\)/);

    const handler = handlerBlock('connections:update');
    assert.match(handler, /if \(normalizedPatch\.apiKey !== undefined\) \{[\s\S]*if \(normalizedPatch\.apiKey\) await credentialStore\.setSecret\(slug, 'api_key', normalizedPatch\.apiKey\);[\s\S]*else await credentialStore\.deleteSecret\(slug, 'api_key'\);/);
  });

  it('keeps OAuth baseUrl normalization and provider-aware secret resolution wired', () => {
    assert.match(
      mainSource,
      /function normalizeCreateConnectionInput\(input: CreateConnectionInput\): CreateConnectionInput \{[\s\S]*defaults\.authKind === 'oauth_token'[\s\S]*baseUrl: defaults\.baseUrl/,
      'create must continue forcing canonical OAuth provider baseUrl',
    );
    assert.match(
      mainSource,
      /async function normalizeUpdateConnectionInput\([\s\S]*const defaults = providerType \? PROVIDER_DEFAULTS\[providerType\] : undefined;[\s\S]*defaults\?\.authKind === 'oauth_token'[\s\S]*hasOwnProperty\.call\(normalizedPatch, 'baseUrl'\)[\s\S]*baseUrl: existing\?\.baseUrl \?\? defaults\.baseUrl/,
      'update must preserve the main-owned account endpoint for OAuth providers',
    );
    assert.match(mainSource, /connections:test[\s\S]*const apiKey = await resolveConnectionSecret\(slug\)/);
    assert.match(discoveryService, /const apiKey = await deps\.resolveConnectionSecret\(slug\)/);
    // hasSecret is the exception: a read-only status probe (session
    // health notice) that must use the read-only hasConnectionSecret,
    // so observing it never refreshes OAuth tokens or hits the network.
    assert.match(mainSource, /connections:hasSecret[\s\S]*return hasConnectionSecret\(connection\)/);
    assert.match(
      mainSource,
      /registerConnectionsIpc\(\{[\s\S]*resolveConnectionSecret,[\s\S]*hasConnectionSecret,[\s\S]*\}\)/,
      'registerConnectionsIpc must be wired with the read-only hasConnectionSecret alongside resolveConnectionSecret',
    );
  });

  it('lets optional-auth providers test and discover models without a saved key', () => {
    const testHandler = handlerBlock('connections:test');
    const fetchHandler = handlerBlock('connections:fetchModels');
    assert.match(testHandler, /providerAuthRequiresSecret\(connection\.providerType\)[\s\S]*!apiKey/);
    assert.match(fetchHandler, /discoverConnectionModels\(\{[\s\S]*resolveConnectionSecret/);
    assert.match(
      discoveryService,
      /providerAuthRequiresSecret\(connection\.providerType\)[\s\S]*!apiKey/,
    );
    assert.match(
      mainSource,
      /async function resolveModelContext[\s\S]*providerAuthRequiresSecret\(connection\.providerType\)[\s\S]*!apiKey/,
      'Daily Review must share the same optional-auth boundary as chat and connection discovery',
    );
  });

  it('does not echo cleartext API keys in thrown errors or IPC return values', () => {
    const validatorRegion = mainSource.match(/function normalizeConnectionApiKeyForIpc[\s\S]*?function normalizeCreateConnectionInput/)?.[0] ?? '';
    const createHandler = handlerBlock('connections:create');
    const updateHandler = handlerBlock('connections:update');

    for (const source of [validatorRegion, createHandler, updateHandler]) {
      assert.doesNotMatch(source, /errorMessage:\s*[^,\n]*apiKey/);
      assert.doesNotMatch(source, /throw new Error\([^)]*apiKey[^)]*\$\{[^}]*value/);
      assert.doesNotMatch(source, /return \{[\s\S]*apiKey[\s\S]*\}/);
    }
  });
});
