import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ConnectionCredentialRouting } from '@maka/core/runtime-policy';
import {
  ProviderCredentialRouter,
  RouterPoolExhaustedError,
  type RouterCredentialMaterial,
  type RouterProfileProvider,
} from '../server/provider-credential-router.js';

interface ProviderState {
  routing: ConnectionCredentialRouting | null;
  eligible: (
    connectionId: string,
    profileIds: readonly string[],
    modelId: string,
  ) => Promise<ReadonlySet<string>>;
  credentials: (
    connectionId: string,
    profileId: string,
  ) => Promise<RouterCredentialMaterial | null>;
  settleCalls: Array<{ profileId: string; outcomeKind: string }>;
}

function routing(profiles: Array<{ id: string; weight: number }>): ConnectionCredentialRouting {
  return {
    mode: 'balanced',
    strategy: 'smooth_weighted_round_robin',
    profiles: profiles.map((profile) => ({
      profileId: profile.id,
      revision: 1,
      label: profile.id,
      enabled: true,
      weight: profile.weight,
    })),
  };
}

function createProvider(state: Partial<ProviderState>): RouterProfileProvider {
  const settleCalls: ProviderState['settleCalls'] = [];
  const provider: RouterProfileProvider = {
    getRouting: async () => state.routing ?? null,
    getEligibleProfileIds: async (connectionId, profileIds, modelId) =>
      state.eligible
        ? state.eligible(connectionId, profileIds, modelId)
        : new Set<string>(profileIds),
    resolveCredential: async (connectionId, profileId) =>
      state.credentials
        ? state.credentials(connectionId, profileId)
        : { credentialId: `cred-${profileId}`, credentialRevision: 1, apiKey: `key-${profileId}` },
    settleHealth: async (lease, outcome) => {
      settleCalls.push({ profileId: lease.profileId, outcomeKind: outcome.kind });
    },
  };
  return Object.assign(provider, { __settleCalls: settleCalls });
}

function context(
  overrides: Partial<Parameters<ProviderCredentialRouter['acquireAttempt']>[0]> = {},
): Parameters<ProviderCredentialRouter['acquireAttempt']>[0] {
  return {
    connectionId: 'connection-1',
    connectionSlug: 'openai',
    providerId: 'openai',
    modelId: 'gpt-5',
    sessionId: 'session-1',
    turnId: 'turn-1',
    logicalCallId: 'call-1',
    callKind: 'main',
    excludedProfileIds: new Set<string>(),
    reason: 'initial' as const,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('ProviderCredentialRouter', () => {
  test('legacy single fast path never touches weighted state and never fabricates failover', async () => {
    const provider = createProvider({ routing: null });
    const router = new ProviderCredentialRouter(provider);
    const lease = await router.acquireAttempt(context());
    assert.equal(lease.profileId, 'connection-1');
    assert.equal(lease.selectionReason, 'legacy_single');
    assert.equal(lease.apiKey, 'key-connection-1');

    const legacyPrimary = createProvider({
      routing: {
        mode: 'legacy_primary',
        strategy: 'smooth_weighted_round_robin',
        profiles: [
          { profileId: 'connection-1', revision: 1, label: 'primary', enabled: true, weight: 1 },
          { profileId: 'secondary-1', revision: 1, label: 'backup', enabled: false, weight: 1 },
        ],
      },
    });
    const router2 = new ProviderCredentialRouter(legacyPrimary);
    const lease2 = await router2.acquireAttempt(context());
    assert.equal(lease2.profileId, 'connection-1');
    assert.equal(lease2.selectionReason, 'legacy_single');
  });

  test('single eligible candidate in balanced mode uses single_eligible', async () => {
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 2 },
        { id: 'b', weight: 1 },
      ]),
      eligible: async (_c, ids) => new Set(ids.filter((id) => id === 'a')),
    });
    const router = new ProviderCredentialRouter(provider);
    const lease = await router.acquireAttempt(context());
    assert.equal(lease.profileId, 'a');
    assert.equal(lease.selectionReason, 'single_eligible');
  });

  test('2:1 weights approximate the stable SWRR sequence', async () => {
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 2 },
        { id: 'b', weight: 1 },
      ]),
    });
    const router = new ProviderCredentialRouter(provider);
    const picked: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      const lease = await router.acquireAttempt(
        context({ sessionId: `s-${index}`, turnId: `t-${index}` }),
      );
      picked.push(lease.profileId);
    }
    const countA = picked.filter((id) => id === 'a').length;
    const countB = picked.filter((id) => id === 'b').length;
    assert.equal(countA + countB, 60);
    // 2:1 over 60 picks: A should get roughly 40, B roughly 20.
    assert.ok(countA >= 35 && countA <= 45, `A picked ${countA} times`);
    assert.ok(countB >= 15 && countB <= 25, `B picked ${countB} times`);
    // The sequence must not have long blocks of the same profile.
    for (let index = 0; index < picked.length - 2; index += 1) {
      assert.ok(
        !(picked[index] === picked[index + 1] && picked[index + 1] === picked[index + 2]),
        'SWRR must not produce long runs',
      );
    }
  });

  test('5:2:1 weights distribute over a long sequence', async () => {
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 5 },
        { id: 'b', weight: 2 },
        { id: 'c', weight: 1 },
      ]),
    });
    const router = new ProviderCredentialRouter(provider);
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    for (let index = 0; index < 240; index += 1) {
      const lease = await router.acquireAttempt(
        context({ sessionId: `s-${index}`, turnId: `t-${index}` }),
      );
      counts[lease.profileId] += 1;
    }
    // 5:2:1 of 240 = 150 / 60 / 30.
    assert.ok(counts.a >= 140 && counts.a <= 160, `a=${counts.a}`);
    assert.ok(counts.b >= 52 && counts.b <= 68, `b=${counts.b}`);
    assert.ok(counts.c >= 24 && counts.c <= 36, `c=${counts.c}`);
  });

  test('turn stickiness: multiple steps in one turn reuse the same profile', async () => {
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
      ]),
    });
    const router = new ProviderCredentialRouter(provider);
    const first = await router.acquireAttempt(context());
    const second = await router.acquireAttempt(context({ logicalCallId: 'call-2' }));
    const third = await router.acquireAttempt(context({ logicalCallId: 'call-3' }));
    assert.equal(second.profileId, first.profileId);
    assert.equal(third.profileId, first.profileId);
    // A new turn participates in load balancing again.
    const nextTurn = await router.acquireAttempt(
      context({ turnId: 'turn-2', sessionId: 'session-1' }),
    );
    assert.ok(nextTurn.profileId === 'a' || nextTurn.profileId === 'b');
  });

  test('account failover excludes the failed profile for the rest of the logical call', async () => {
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
      ]),
    });
    const router = new ProviderCredentialRouter(provider);
    const first = await router.acquireAttempt(context());
    const failover = await router.acquireAttempt(
      context({
        logicalCallId: 'call-1',
        excludedProfileIds: new Set([first.profileId]),
        reason: 'account_failover',
      }),
    );
    assert.notEqual(failover.profileId, first.profileId);
    assert.equal(failover.selectionReason, 'account_failover');
  });

  test('binding_invalidated reselects without failover credit', async () => {
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
      ]),
    });
    const router = new ProviderCredentialRouter(provider);
    const first = await router.acquireAttempt(context());
    const reselect = await router.acquireAttempt(
      context({ logicalCallId: 'call-1', reason: 'binding_invalidated' }),
    );
    assert.equal(reselect.selectionReason, 'binding_reselect');
    // The reselect still honors a fresh turn's SWRR state.
    assert.ok(reselect.profileId === 'a' || reselect.profileId === 'b');
    void first;
  });

  test('half_open_probe retries the previously failing profile', async () => {
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
      ]),
    });
    const router = new ProviderCredentialRouter(provider);
    const first = await router.acquireAttempt(context());
    const probe = await router.acquireAttempt(
      context({
        excludedProfileIds: new Set([first.profileId]),
        reason: 'half_open_probe',
      }),
    );
    assert.equal(probe.profileId, first.profileId);
    assert.equal(probe.selectionReason, 'half_open_probe');
  });

  test('pool exhausted throws when no profile is eligible', async () => {
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
      ]),
      eligible: async () => new Set(),
    });
    const router = new ProviderCredentialRouter(provider);
    await assert.rejects(
      router.acquireAttempt(context()),
      (error: unknown) => error instanceof RouterPoolExhaustedError,
    );
  });

  test('a profile that loses its credential during selection triggers a fail-closed reselect', async () => {
    let credentialsEnabled = true;
    let eligibleProfileIds: string[] = ['a', 'b'];
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
      ]),
      eligible: async (_c, _ids) => new Set(eligibleProfileIds),
      credentials: async (_c, profileId) => {
        if (!credentialsEnabled && profileId === 'a') return null;
        return {
          credentialId: `cred-${profileId}`,
          credentialRevision: 1,
          apiKey: `key-${profileId}`,
        };
      },
    });
    const router = new ProviderCredentialRouter(provider);
    // First acquire binds to some profile with both eligible.
    const first = await router.acquireAttempt(context());
    void first;
    // Remove the credential for 'a' and force 'a' as the only candidate.
    credentialsEnabled = false;
    eligibleProfileIds = ['a'];
    await assert.rejects(
      router.acquireAttempt(context({ turnId: 'turn-new' })),
      (error: unknown) => error instanceof RouterPoolExhaustedError,
    );
  });

  test('releaseTurn frees the binding so the next call re-enters SWRR', async () => {
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
      ]),
    });
    const router = new ProviderCredentialRouter(provider);
    const first = await router.acquireAttempt(context());
    router.releaseTurn('session-1', 'turn-1');
    const second = await router.acquireAttempt(context());
    assert.notEqual(second.profileId, first.profileId, 'release must free the sticky binding');
  });

  test('settle forwards outcomes to the health provider', async () => {
    const provider = createProvider({ routing: null });
    const router = new ProviderCredentialRouter(provider);
    const lease = await router.acquireAttempt(context());
    await router.settle(lease, { kind: 'success' });
    const calls = (provider as RouterProfileProvider & { __settleCalls: unknown[] })
      .__settleCalls as Array<{ profileId: string; outcomeKind: string }>;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.profileId, lease.profileId);
    assert.equal(calls[0]!.outcomeKind, 'success');
  });

  test('aborted signal fails the acquire before dispatch', async () => {
    const provider = createProvider({ routing: null });
    const router = new ProviderCredentialRouter(provider);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(router.acquireAttempt(context({ signal: controller.signal })), /aborted/);
  });

  test('profile disable or credential replace invalidates the old binding before dispatch', async () => {
    // Simulate: turn-1 binds to 'a'; before the next dispatch the catalog
    // replaces the credential so the old material must not be reused.
    let credentialRevision = 1;
    const provider = createProvider({
      routing: routing([
        { id: 'a', weight: 1 },
        { id: 'b', weight: 1 },
      ]),
      credentials: async (_c, profileId) => ({
        credentialId: `cred-${profileId}`,
        credentialRevision,
        apiKey: `key-${profileId}-v${credentialRevision}`,
      }),
    });
    const router = new ProviderCredentialRouter(provider);
    const first = await router.acquireAttempt(context());
    assert.equal(first.credentialRevision, 1);
    // Credential replaced; the router must resolve the newest material even
    // though the turn binding still points at the same profile.
    credentialRevision = 2;
    const second = await router.acquireAttempt(context({ logicalCallId: 'call-2' }));
    assert.equal(second.credentialRevision, 2, 'acquire must re-resolve the newest credential');
  });
});
