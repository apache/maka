import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  defaultWebSearchSettings,
  maskedTokenForDisplay,
  mergeWebSearchSettings,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
  normalizeWebSearchSettings,
  reconcileMaskedToken,
  webSearchCredentialSourceFromStoredKey,
  webSearchCredentialStatusFromResponse,
} from '../web-search.js';

describe('web search settings', () => {
  it('normalizes bounded queries and result limits', () => {
    assert.equal(normalizeWebSearchQuery('  hello world  '), 'hello world');
    for (const value of ['   ', undefined]) {
      assert.equal(normalizeWebSearchQuery(value), null);
    }
    assert.equal(normalizeWebSearchQuery('a'.repeat(201))?.length, 200);

    const limits: Array<[unknown, number]> = [
      [undefined, 5],
      [NaN, 5],
      [0, 1],
      [3.7, 3],
      [11, 10],
    ];
    for (const [value, expected] of limits) assert.equal(normalizeWebSearchLimit(value), expected);
  });

  it('masks persisted tokens while preserving explicit replace and clear operations', () => {
    const reconciled = [
      ['secret-key', '••••••', 'secret-key'],
      ['old', 'new-token', 'new-token'],
      ['old', '', ''],
    ] as const;
    for (const [persisted, candidate, expected] of reconciled) {
      assert.equal(reconcileMaskedToken(persisted, candidate), expected);
    }
    assert.equal(maskedTokenForDisplay(''), '');
    assert.equal(maskedTokenForDisplay('secret'), '••••••');
  });

  it('preserves validation metadata for a masked round-trip and resets it for a new key', () => {
    const current = mergeWebSearchSettings(defaultWebSearchSettings(), {
      providers: {
        tavily: {
          apiKey: 'stored-key',
          credentialStatus: 'valid',
          credentialCheckedAt: '2026-05-29T00:00:00.000Z',
        },
      },
    });
    const masked = mergeWebSearchSettings(current, {
      providers: { tavily: { apiKey: '••••••' } },
    });
    assert.deepEqual(masked.providers.tavily, current.providers.tavily);

    const changed = mergeWebSearchSettings(current, {
      providers: { tavily: { apiKey: 'new-key' } },
    });
    assert.equal(changed.providers.tavily.apiKey, 'new-key');
    assert.equal(changed.providers.tavily.credentialSource, 'saved');
    assert.equal(changed.providers.tavily.credentialVersion, 2);
    assert.equal(changed.providers.tavily.credentialStatus, 'untested');
    assert.equal(changed.providers.tavily.credentialCheckedAt, undefined);
  });

  it('ignores stale credential results after the key version changes', () => {
    const original = mergeWebSearchSettings(defaultWebSearchSettings(), {
      providers: { tavily: { apiKey: 'old-key' } },
    });
    const current = mergeWebSearchSettings(original, {
      providers: { tavily: { apiKey: 'new-key' } },
    });
    const applyResult = (
      credentialVersion: number,
      credentialStatus: 'valid' | 'invalid_credentials',
    ) =>
      mergeWebSearchSettings(current, {
        providers: {
          tavily: {
            credentialVersion,
            credentialStatus,
            credentialCheckedAt: '2026-05-29T00:01:00.000Z',
          },
        },
      });

    assert.equal(
      applyResult(original.providers.tavily.credentialVersion, 'invalid_credentials').providers
        .tavily.credentialStatus,
      'untested',
    );
    assert.equal(
      applyResult(current.providers.tavily.credentialVersion, 'valid').providers.tavily
        .credentialStatus,
      'valid',
    );
  });

  it('normalizes malformed persisted credential metadata fail-closed', () => {
    const normalized = normalizeWebSearchSettings({
      enabled: 'yes',
      defaultProvider: 'unknown',
      providers: {
        tavily: {
          apiKey: 'x'.repeat(257),
          credentialSource: 'saved',
          credentialVersion: -1,
          credentialStatus: 'unknown',
          credentialCheckedAt: 'x'.repeat(65),
        },
      },
    } as never);

    assert.deepEqual(normalized, {
      enabled: false,
      defaultProvider: 'model',
      providers: {
        tavily: {
          apiKey: '',
          credentialSource: 'none',
          credentialVersion: 0,
          credentialStatus: 'untested',
        },
      },
    });
  });

  it('derives renderer-safe credential metadata from storage and test responses', () => {
    assert.equal(webSearchCredentialSourceFromStoredKey(''), 'none');
    assert.equal(webSearchCredentialSourceFromStoredKey('tvly-secret'), 'saved');
    assert.equal(webSearchCredentialStatusFromResponse({ ok: true, results: [] }), 'valid');
    assert.equal(
      webSearchCredentialStatusFromResponse({
        ok: false,
        reason: 'invalid_credentials',
        message: 'bad',
      }),
      'invalid_credentials',
    );
    assert.equal(
      webSearchCredentialStatusFromResponse({
        ok: false,
        reason: 'unsupported_provider',
        message: 'no',
      }),
      'network_error',
    );
  });
});
