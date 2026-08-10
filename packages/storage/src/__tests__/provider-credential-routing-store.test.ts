import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type {
  CredentialProfileVerificationRecord,
  ProviderFailureRoutingHint,
} from '@maka/core/provider-credential-routing';
import {
  createSqliteProviderCredentialRoutingStore,
  executionBasisDigest,
  type ProviderCredentialRoutingStore,
} from '../provider-credential-routing-store.js';

const CONNECTION = '00000000-0000-4000-8000-000000000001';
const PROFILE = '00000000-0000-4000-8000-00000000000a';
const SECONDARY = '00000000-0000-4000-8000-00000000000b';
const CREDENTIAL = '00000000-0000-4000-8000-0000000000c1';

const BASIS_A = executionBasisDigest({
  providerType: 'openai',
  endpoint: 'https://api.openai.com/v1',
  apiProtocol: 'openai-chat',
  requestHeadersCredentialId: null,
  requestHeadersCredentialRevision: null,
  requestBodyOverlayJson: null,
});

const BASIS_B = executionBasisDigest({
  providerType: 'openai',
  endpoint: 'https://different.example/v1',
  apiProtocol: 'openai-chat',
  requestHeadersCredentialId: null,
  requestHeadersCredentialRevision: null,
  requestBodyOverlayJson: null,
});

function verification(
  modelId: string,
  overrides: Partial<CredentialProfileVerificationRecord> = {},
): CredentialProfileVerificationRecord {
  return {
    connectionId: CONNECTION,
    profileId: PROFILE,
    credentialId: CREDENTIAL,
    credentialRevision: 1,
    executionBasisDigest: BASIS_A,
    modelId,
    status: 'supported',
    source: 'discovered',
    evidence: 'positive_only',
    checkedAt: 1000,
    ...overrides,
  };
}

function hint(
  kind: ProviderFailureRoutingHint['kind'],
  scope: ProviderFailureRoutingHint['scope'],
): ProviderFailureRoutingHint {
  return { kind, scope, evidence: 'status' };
}

async function withStore(
  run: (store: ProviderCredentialRoutingStore) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-routing-'));
  try {
    const store = createSqliteProviderCredentialRoutingStore(root);
    await run(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('executionBasisDigest', () => {
  test('is deterministic and endpoint-sensitive but secret-free', () => {
    assert.equal(
      executionBasisDigest({
        providerType: 'openai',
        endpoint: 'https://api.openai.com/v1',
        apiProtocol: 'openai-chat',
        requestHeadersCredentialId: null,
        requestHeadersCredentialRevision: null,
        requestBodyOverlayJson: null,
      }),
      BASIS_A,
    );
    assert.notEqual(BASIS_A, BASIS_B);
    assert.ok(!BASIS_A.includes('openai'), 'digest must not leak basis content');
  });

  test('changes when request headers credential identity changes', () => {
    const withHeaders = executionBasisDigest({
      providerType: 'openai',
      endpoint: 'https://api.openai.com/v1',
      apiProtocol: 'openai-chat',
      requestHeadersCredentialId: 'headers-1',
      requestHeadersCredentialRevision: 2,
      requestBodyOverlayJson: null,
    });
    assert.notEqual(withHeaders, BASIS_A);
  });
});

describe('SqliteProviderCredentialRoutingStore', () => {
  test('upserts and reads profile verification', async () => {
    await withStore(async (store) => {
      await store.upsertVerification(verification('gpt-5'));
      await store.upsertVerification(verification('gpt-5', { status: 'denied', source: 'tested' }));
      const rows = await store.readProfileVerification(CONNECTION, PROFILE);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, 'denied', 'upsert replaces the explicit item');
      assert.equal(rows[0]!.source, 'tested');
    });
  });

  test('authoritative replacement removes rows outside the new set', async () => {
    await withStore(async (store) => {
      await store.upsertVerification(verification('gpt-5'));
      await store.upsertVerification(verification('gpt-4o'));
      await store.replaceVerificationBasis(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A, [
        verification('gpt-5', { evidence: 'authoritative', source: 'discovered' }),
      ]);
      const rows = await store.readProfileVerification(CONNECTION, PROFILE);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.modelId, 'gpt-5');
      assert.equal(rows[0]!.evidence, 'authoritative');
    });
  });

  test('clean success settle is a no-op without an existing circuit', async () => {
    await withStore(async (store) => {
      await store.settleSuccess(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A, 'gpt-5', 2000);
      const health = await store.readHealth(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A);
      assert.equal(health.length, 0, 'a clean success must not manufacture a row');
    });
  });

  test('auth failure marks the circuit invalid; success clears it', async () => {
    await withStore(async (store) => {
      await store.settleFailure(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        hint('auth', 'credential'),
        2000,
      );
      let health = await store.readHealth(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A);
      assert.equal(health[0]!.circuitState, 'invalid');
      await store.settleSuccess(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A, 'gpt-5', 3000);
      health = await store.readHealth(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A);
      assert.equal(health[0]!.circuitState, 'closed');
      assert.equal(health[0]!.consecutiveFailures, 0);
    });
  });

  test('rate limit opens a circuit with a bounded probe cadence', async () => {
    await withStore(async (store) => {
      await store.settleFailure(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        hint('rate_limit', 'credential'),
        2000,
      );
      const health = await store.readHealth(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A);
      assert.equal(health[0]!.circuitState, 'open');
      assert.ok(health[0]!.nextProbeAt! > 2000);
    });
  });

  test('network/connection-scoped failures never change profile health', async () => {
    await withStore(async (store) => {
      await store.settleFailure(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        hint('network', 'connection'),
        2000,
      );
      await store.settleFailure(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        hint('unknown', 'unknown'),
        3000,
      );
      const health = await store.readHealth(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A);
      assert.equal(health.length, 0, 'connection/unknown scopes must not create rows');
    });
  });

  test('only one half-open probe is admitted per circuit', async () => {
    await withStore(async (store) => {
      await store.settleFailure(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        hint('rate_limit', 'credential'),
        2000,
      );
      const first = await store.claimHalfOpenProbe(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        200_000,
      );
      assert.equal(first, true);
      const second = await store.claimHalfOpenProbe(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        210_000,
      );
      assert.equal(second, false, 'a second probe while half-open must be refused');
    });
  });

  test('half-open probe is refused before the cooldown elapses', async () => {
    await withStore(async (store) => {
      await store.settleFailure(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        hint('rate_limit', 'credential'),
        2000,
      );
      const early = await store.claimHalfOpenProbe(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        2500,
      );
      assert.equal(early, false);
    });
  });

  test('credential revision change separates old and new health', async () => {
    await withStore(async (store) => {
      await store.settleFailure(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        hint('auth', 'credential'),
        2000,
      );
      // New credential revision reads fresh (empty) health.
      const fresh = await store.readHealth(CONNECTION, PROFILE, CREDENTIAL, 2, BASIS_A);
      assert.equal(fresh.length, 0);
      // Old revision keeps its invalid state.
      const old = await store.readHealth(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A);
      assert.equal(old[0]!.circuitState, 'invalid');
    });
  });

  test('deleteConnection and deleteProfile remove verification and health', async () => {
    await withStore(async (store) => {
      await store.upsertVerification(verification('gpt-5'));
      await store.settleFailure(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        hint('auth', 'credential'),
        2000,
      );
      await store.settleFailure(
        CONNECTION,
        SECONDARY,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        hint('auth', 'credential'),
        2000,
      );
      await store.deleteProfile(CONNECTION, PROFILE);
      assert.equal((await store.readProfileVerification(CONNECTION, PROFILE)).length, 0);
      assert.equal((await store.readHealth(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A)).length, 0);
      assert.equal(
        (await store.readHealth(CONNECTION, SECONDARY, CREDENTIAL, 1, BASIS_A)).length,
        1,
      );
      await store.deleteConnection(CONNECTION);
      assert.equal(
        (await store.readHealth(CONNECTION, SECONDARY, CREDENTIAL, 1, BASIS_A)).length,
        0,
      );
    });
  });

  test('cleanup removes stale profiles and over-aged closed rows', async () => {
    await withStore(async (store) => {
      await store.upsertVerification(verification('gpt-5'));
      await store.settleFailure(
        CONNECTION,
        PROFILE,
        CREDENTIAL,
        1,
        BASIS_A,
        'gpt-5',
        hint('rate_limit', 'credential'),
        1000,
      );
      await store.settleSuccess(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A, 'gpt-5', 2000);
      const now = 2000 + 31 * 24 * 60 * 60 * 1000;
      // PROFILE is not in the live set -> removed. A fresh profile is kept.
      await store.cleanup(new Set([`${CONNECTION}\u0000${SECONDARY}`]), now);
      assert.equal((await store.readProfileVerification(CONNECTION, PROFILE)).length, 0);
      assert.equal((await store.readHealth(CONNECTION, PROFILE, CREDENTIAL, 1, BASIS_A)).length, 0);
    });
  });
});
