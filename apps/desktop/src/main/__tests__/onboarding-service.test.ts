/**
 * Tests for the onboarding service (PR110b).
 *
 * Validate the contract gates @kenji + @xuan signed off on:
 *   - getSnapshot resolves credentials in parallel (timing assertion)
 *   - credential lookup errors are NEVER thrown to caller; the slug
 *     is treated as `hasSecret: false`
 *   - setMilestone rejects invalid id / status
 *   - setMilestone never accepts a renderer-supplied timestamp
 *   - last-valid-entry-wins dedup survives via the sanitizer
 *   - `bindOnboardingDeps` passes the full `LlmConnection` (not just a
 *     slug) to `hasCredential`, so OAuth-subscription connections are
 *     recognized as credentialed via a read-only check
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  OnboardingMilestone,
  OnboardingMilestoneId,
  SessionSummary,
} from '@maka/core';
import type { LlmConnection } from '@maka/core';
import {
  bindOnboardingDeps,
  createOnboardingService,
  type OnboardingServiceDeps,
} from '../onboarding-service.js';

function realConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: overrides.slug ?? 'anthropic-live',
    name: overrides.name ?? 'Anthropic Live',
    providerType: overrides.providerType ?? 'anthropic',
    defaultModel: overrides.defaultModel ?? 'claude-sonnet-4-5-20250929',
    enabled: overrides.enabled ?? true,
    models: overrides.models ?? [
      { id: 'claude-sonnet-4-5-20250929', capabilities: { vision: true, reasoning: true, functionCalling: true }, contextWindow: 200_000 },
    ],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as LlmConnection;
}

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'a',
    connectionLocked: true,
    model: 'claude-sonnet-4-5-20250929',
    permissionMode: 'ask',
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<OnboardingServiceDeps> = {}): OnboardingServiceDeps {
  const milestones: OnboardingMilestone[] = [];
  return {
    listConnections: async () => [],
    getDefaultSlug: async () => null,
    listSessions: async () => [] as SessionSummary[],
    getMilestones: async () => milestones,
    upsertMilestone: async (id, status) => {
      const timestamp = Date.now();
      const next: OnboardingMilestone =
        status === 'completed' ? { id, completedAt: timestamp } : { id, skippedAt: timestamp };
      // Dedup last-wins by id.
      const existingIdx = milestones.findIndex((m) => m.id === id);
      if (existingIdx >= 0) milestones[existingIdx] = next;
      else milestones.push(next);
      return milestones.slice();
    },
    clearMilestone: async (id) => {
      const existingIdx = milestones.findIndex((m) => m.id === id);
      if (existingIdx >= 0) milestones.splice(existingIdx, 1);
      return milestones.slice();
    },
    hasCredential: async (_connection: LlmConnection) => false,
    ...overrides,
  };
}

describe('createOnboardingService.getSnapshot', () => {
  it('pins the complete renderer projection for every physical session', async () => {
    const service = createOnboardingService(fakeDeps({
      listConnections: async () => [realConnection({ slug: 'a' })],
      getDefaultSlug: async () => 'a',
      listSessions: async () => [
        session(),
        session({ id: 's2', llmConnectionSlug: 'removed' }),
      ],
      getMilestones: async () => [{ id: 'initial_onboarding', completedAt: 1 }],
      hasCredential: async () => true,
    }));

    const snapshot = await service.getSnapshot();
    assert.deepEqual({
      chatModelChoices: snapshot.chatModelChoices,
      sessionSendOutcomes: snapshot.sessionSendOutcomes,
    }, {
      chatModelChoices: [{
        connectionSlug: 'a',
        providerType: 'anthropic',
        providerLabel: 'Anthropic',
        model: 'claude-sonnet-4-5-20250929',
        label: 'Claude Sonnet 4.5',
        connectionName: 'Anthropic Live',
        isDefault: true,
        thinkingLevels: ['off'],
      }],
      sessionSendOutcomes: {
        s1: { kind: 'ready' },
        s2: {
          kind: 'blocked',
          reason: 'connection_missing',
          connectionLocked: true,
        },
      },
    });
    assert.deepEqual(
      Object.keys(snapshot.sessionSendOutcomes).sort(),
      snapshot.sessions.map((item) => item.id).sort(),
    );
  });

  it('returns derived OnboardingState + sanitized milestones together', async () => {
    const service = createOnboardingService(
      fakeDeps({
        listConnections: async () => [realConnection({ slug: 'a' })],
        getDefaultSlug: async () => 'a',
        hasCredential: async (connection) => connection.slug === 'a',
        getMilestones: async () => [{ id: 'first_chat_sent', completedAt: 1_700_000_000_000 }],
      }),
    );
    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.state.kind, 'ready_empty');
    assert.deepEqual(snapshot.milestones, [
      { id: 'first_chat_sent', completedAt: 1_700_000_000_000 },
    ]);
    assert.equal(snapshot.chatModelChoices[0]?.providerLabel, 'Anthropic');
    assert.equal(snapshot.chatModelChoices[0]?.isDefault, true);
  });

  it('projects session send readiness again after connection credentials change', async () => {
    let hasCredential = true;
    const service = createOnboardingService(fakeDeps({
      listConnections: async () => [realConnection({ slug: 'a' })],
      getDefaultSlug: async () => 'a',
      listSessions: async () => [session()],
      getMilestones: async () => [{ id: 'initial_onboarding', completedAt: 1 }],
      hasCredential: async () => hasCredential,
    }));

    assert.deepEqual((await service.getSnapshot()).sessionSendOutcomes.s1, { kind: 'ready' });
    hasCredential = false;
    assert.deepEqual((await service.getSnapshot()).sessionSendOutcomes.s1, {
      kind: 'blocked',
      reason: 'missing_api_key',
      connectionLocked: true,
    });
  });

  it('keeps physical revision summaries in the snapshot for version navigation', async () => {
    const root = { id: 'root', revisionState: undefined } as unknown as SessionSummary;
    const revision = {
      id: 'revision',
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'root',
      revisionIndex: 2,
      revisionState: 'committed',
    } as unknown as SessionSummary;
    const service = createOnboardingService(
      fakeDeps({
        listConnections: async () => [realConnection({ slug: 'a' })],
        getDefaultSlug: async () => 'a',
        hasCredential: async () => true,
        listSessions: async () => [revision, root],
        getMilestones: async () => [{ id: 'initial_onboarding', completedAt: 1 }],
      }),
    );

    const snapshot = await service.getSnapshot();
    assert.deepEqual(snapshot.sessions.map((session) => session.id), ['revision', 'root']);
  });

  it('resolves per-connection credentials in PARALLEL (@kenji perf gate)', async () => {
    const conns = ['a', 'b', 'c', 'd'].map((slug) => realConnection({ slug }));
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = createOnboardingService(
      fakeDeps({
        listConnections: async () => conns,
        getDefaultSlug: async () => 'a',
        hasCredential: async () => {
          started += 1;
          await gate;
          return true;
        },
      }),
    );
    const snapshot = service.getSnapshot();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const startedBeforeRelease = started;
    release();
    await snapshot;
    assert.equal(startedBeforeRelease, conns.length, 'every credential lookup must start before any lookup finishes');
  });

  it('credential-lookup error → treated as hasSecret=false, NEVER thrown to caller', async () => {
    const service = createOnboardingService(
      fakeDeps({
        listConnections: async () => [realConnection({ slug: 'broken' })],
        getDefaultSlug: async () => 'broken',
        hasCredential: async () => {
          throw new Error('safeStorage decrypt failed');
        },
      }),
    );
    // The call must NOT reject; the missing secret routes the user to
    // `needs_connection_credentials`.
    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.state.kind, 'needs_connection_credentials');
    if (snapshot.state.kind === 'needs_connection_credentials') {
      assert.equal(snapshot.state.connectionSlug, 'broken');
    }
  });

  it('backfills initial_onboarding as completed when user already has sessions', async () => {
    const upsertCalls: Array<{ id: string; status: string }> = [];
    const service = createOnboardingService(
      fakeDeps({
        listConnections: async () => [realConnection({ slug: 'a' })],
        getDefaultSlug: async () => 'a',
        hasCredential: async () => true,
        listSessions: async () => [{ id: 's1', title: 'old', createdAt: 1, updatedAt: 1 } as unknown as SessionSummary],
        getMilestones: async () => [],
        upsertMilestone: async (id, status) => {
          upsertCalls.push({ id, status });
          return [{ id, completedAt: Date.now() }];
        },
      }),
    );
    const snapshot = await service.getSnapshot();
    assert.equal(upsertCalls.length, 1);
    assert.equal(upsertCalls[0].id, 'initial_onboarding');
    assert.equal(upsertCalls[0].status, 'completed');
    assert.ok(snapshot.milestones.some((m) => m.id === 'initial_onboarding' && m.completedAt !== undefined));
  });

  it('does NOT backfill when user has sessions but initial_onboarding already settled', async () => {
    const upsertCalls: Array<{ id: string; status: string }> = [];
    const service = createOnboardingService(
      fakeDeps({
        listConnections: async () => [realConnection({ slug: 'a' })],
        getDefaultSlug: async () => 'a',
        hasCredential: async () => true,
        listSessions: async () => [{ id: 's1', title: 'old', createdAt: 1, updatedAt: 1 } as unknown as SessionSummary],
        getMilestones: async () => [{ id: 'initial_onboarding', completedAt: 1 }],
        upsertMilestone: async (id, status) => {
          upsertCalls.push({ id, status });
          return [{ id, completedAt: 1 }];
        },
      }),
    );
    await service.getSnapshot();
    assert.equal(upsertCalls.length, 0);
  });

  it('does NOT backfill when user has zero sessions', async () => {
    const upsertCalls: Array<{ id: string; status: string }> = [];
    const service = createOnboardingService(
      fakeDeps({
        listConnections: async () => [realConnection({ slug: 'a' })],
        getDefaultSlug: async () => 'a',
        hasCredential: async () => true,
        listSessions: async () => [],
        upsertMilestone: async (id, status) => {
          upsertCalls.push({ id, status });
          return [{ id, completedAt: Date.now() }];
        },
      }),
    );
    await service.getSnapshot();
    assert.equal(upsertCalls.length, 0);
  });
});

describe('bindOnboardingDeps — hasCredential wiring', () => {
  // Regression test: onboarding used to call a `hasApiKey` that only
  // checked the API-key credential store, so an OAuth-subscription
  // connection (Claude Subscription / Codex Subscription) marked as
  // the default was always reported as `missing_api_key`, even when
  // Settings showed it verified + default. The fix routes onboarding
  // through a `hasCredential(connection)` resolver that special-cases
  // OAuth-subscription connections via a READ-ONLY check (no refresh —
  // see the "does not trigger OAuth refresh" test below). This test
  // wires a fake `hasCredential` that mirrors that split (API-key
  // store for normal connections, a separate token store for OAuth
  // subscriptions) and asserts the OAuth-subscription default resolves
  // to `ready_empty` rather than being stuck on a credentials/default
  // -connection step.
  it('treats an OAuth-subscription default connection as credentialed', async () => {
    const oauthConnection = realConnection({
      slug: 'claude-oauth',
      providerType: 'claude-subscription',
      defaultModel: 'claude-sonnet-4-5-20250929',
    });
    // Deliberately empty: the API-key store has nothing for this slug.
    const apiKeyStore = new Map<string, string>();
    // The OAuth-subscription token lives in a separate store, exactly
    // like claudeSubscription.hasStoredCredential() in main.ts.
    const subscriptionTokenStore = new Set<string>(['claude-oauth']);

    const service = createOnboardingService(
      bindOnboardingDeps({
        settingsStore: {
          get: async () => ({ onboarding: { milestones: [] } }),
          upsertOnboardingMilestone: async () => [],
          clearOnboardingMilestone: async () => [],
        },
        connectionStore: {
          list: async () => [oauthConnection],
          getDefault: async () => 'claude-oauth',
        },
        hasCredential: async (connection) => {
          if (connection.providerType === 'claude-subscription') {
            return subscriptionTokenStore.has(connection.slug);
          }
          return apiKeyStore.has(connection.slug);
        },
        listSessions: async () => [],
      }),
    );

    const snapshot = await service.getSnapshot();
    assert.equal(
      snapshot.state.kind,
      'ready_empty',
      `expected the OAuth-subscription default to be ready; got ${JSON.stringify(snapshot.state)}`,
    );
  });

  // P3 review gate (PR #389, @Astro-Han): onboarding already holds the
  // full `connections` snapshot from `listConnections()` — the bound
  // `hasCredential` must receive that SAME connection object, not just
  // a slug it has to re-resolve. Passing a fresh/different object here
  // would mean the credential check could observe a different
  // connection state than the one `deriveOnboardingState` reasons
  // about, and would cost an avoidable extra store read in production.
  it('passes the exact connection object from listConnections(), not a re-fetched copy', async () => {
    const connection = realConnection({ slug: 'a' });
    const receivedConnections: LlmConnection[] = [];

    const service = createOnboardingService(
      bindOnboardingDeps({
        settingsStore: {
          get: async () => ({ onboarding: { milestones: [] } }),
          upsertOnboardingMilestone: async () => [],
          clearOnboardingMilestone: async () => [],
        },
        connectionStore: {
          list: async () => [connection],
          getDefault: async () => 'a',
        },
        hasCredential: async (received) => {
          receivedConnections.push(received);
          return true;
        },
        listSessions: async () => [],
      }),
    );

    await service.getSnapshot();
    assert.equal(receivedConnections.length, 1);
    assert.equal(
      receivedConnections[0],
      connection,
      'hasCredential must receive the identical connection object listConnections() returned',
    );
  });

  // P2 review gate (PR #389, @Astro-Han): getSnapshot is a read-only
  // status path. It must be able to report an OAuth-subscription
  // connection as credentialed WITHOUT triggering that provider's
  // token-refresh side effect (network call + local token-state
  // mutation) — refreshing on every onboarding read would mean simply
  // opening the app can hit the network, and a failed incidental
  // refresh could misreport a valid login as missing credentials. This
  // mirrors `ClaudeSubscriptionService.hasStoredCredential()` /
  // `OpenAiCodexService.hasStoredCredential()`, which read the
  // persisted token without ever calling `refreshTokens()`.
  it('does not trigger OAuth refresh for a near-expiry token, and still reports credentialed', async () => {
    const oauthConnection = realConnection({
      slug: 'claude-oauth',
      providerType: 'claude-subscription',
    });
    let refreshCalls = 0;
    let readOnlyCalls = 0;
    // Fake OAuth service: a token exists but is one second from
    // expiring. `hasStoredCredential()` (read-only) must still report
    // true without calling `refreshTokens()`.
    const fakeClaudeSubscription = {
      hasStoredCredential: async () => {
        readOnlyCalls += 1;
        return true; // persisted token exists locally, near-expiry
      },
      refreshTokens: async () => {
        refreshCalls += 1;
        return { ok: true };
      },
    };

    const service = createOnboardingService(
      bindOnboardingDeps({
        settingsStore: {
          get: async () => ({ onboarding: { milestones: [] } }),
          upsertOnboardingMilestone: async () => [],
          clearOnboardingMilestone: async () => [],
        },
        connectionStore: {
          list: async () => [oauthConnection],
          getDefault: async () => 'claude-oauth',
        },
        // Mirrors hasConnectionSecret() in main.ts: routes
        // claude-subscription through the read-only check only.
        hasCredential: async (connection) => {
          if (connection.providerType === 'claude-subscription') {
            return fakeClaudeSubscription.hasStoredCredential();
          }
          return false;
        },
        listSessions: async () => [],
      }),
    );

    const snapshot = await service.getSnapshot();
    assert.equal(snapshot.state.kind, 'ready_empty');
    assert.equal(readOnlyCalls, 1, 'must check the read-only path exactly once');
    assert.equal(refreshCalls, 0, 'getSnapshot must NEVER trigger an OAuth token refresh');
  });
});

describe('createOnboardingService.clearMilestone — strict validation', () => {
  it('rejects invalid milestone id (closed enum)', async () => {
    const service = createOnboardingService(fakeDeps());
    await assert.rejects(
      () => service.clearMilestone('not_a_real_milestone'),
      /INVALID_MILESTONE_ID/,
    );
  });

  it('clears one milestone and returns a fresh snapshot', async () => {
    let stored: OnboardingMilestone[] = [
      { id: 'first_chat_sent', completedAt: 1 },
      { id: 'first_model_swap', skippedAt: 2 },
    ];
    const service = createOnboardingService(
      fakeDeps({
        listConnections: async () => [realConnection({ slug: 'a' })],
        getDefaultSlug: async () => 'a',
        hasCredential: async () => true,
        getMilestones: async () => stored,
        clearMilestone: async (id) => {
          stored = stored.filter((entry) => entry.id !== id);
          return stored;
        },
      }),
    );

    const snapshot = await service.clearMilestone('first_model_swap');

    assert.equal(snapshot.state.kind, 'ready_empty');
    assert.deepEqual(snapshot.milestones, [{ id: 'first_chat_sent', completedAt: 1 }]);
  });
});

describe('createOnboardingService.setMilestone — strict validation', () => {
  it('rejects invalid milestone id (closed enum)', async () => {
    const service = createOnboardingService(fakeDeps());
    await assert.rejects(
      () => service.setMilestone('not_a_real_milestone', 'completed'),
      /INVALID_MILESTONE_ID/,
    );
  });

  it('rejects invalid id type (not a string)', async () => {
    const service = createOnboardingService(fakeDeps());
    for (const bad of [null, undefined, 1, true, {}, [], Symbol('x')]) {
      await assert.rejects(
        () => service.setMilestone(bad as unknown, 'completed'),
        /INVALID_MILESTONE_ID/,
        `should reject id=${String(bad)}`,
      );
    }
  });

  it('rejects invalid status (only "completed" | "skipped")', async () => {
    const service = createOnboardingService(fakeDeps());
    for (const bad of ['unknown', '', 'pending', 'done', null, undefined, 1, true]) {
      await assert.rejects(
        () => service.setMilestone('first_chat_sent', bad as unknown),
        /INVALID_MILESTONE_STATUS/,
        `should reject status=${String(bad)}`,
      );
    }
  });

  it('accepts valid input and produces fresh snapshot', async () => {
    let stored: OnboardingMilestone[] = [];
    const service = createOnboardingService(
      fakeDeps({
        listConnections: async () => [realConnection({ slug: 'a' })],
        getDefaultSlug: async () => 'a',
        hasCredential: async () => true,
        getMilestones: async () => stored,
        upsertMilestone: async (id, status) => {
          stored = [
            ...stored.filter((m) => m.id !== id),
            status === 'completed' ? { id, completedAt: 1_700_000_000_000 } : { id, skippedAt: 1_700_000_000_000 },
          ];
          return stored;
        },
      }),
    );
    const snapshot = await service.setMilestone('first_chat_sent', 'completed');
    assert.equal(snapshot.milestones.length, 1);
    assert.equal(snapshot.milestones[0]?.id, 'first_chat_sent');
    assert.ok(snapshot.milestones[0]?.completedAt);
    // State re-derived after milestone write.
    assert.equal(snapshot.state.kind, 'ready_empty');
  });

  it('never accepts a renderer-supplied timestamp (signature is id+status only)', async () => {
    // The IPC bridge type only passes (id, status). Even if a caller
    // crafts a third argument, setMilestone ignores it; the timestamp
    // comes from the underlying store (Date.now()). Verify by passing
    // a tampered third arg and confirming the service ignores it.
    let receivedArgs: unknown[] = [];
    const service = createOnboardingService(
      fakeDeps({
        upsertMilestone: async (id, status, ...rest) => {
          // Capture all args the service forwarded.
          receivedArgs = [id, status, ...rest];
          return [{ id, completedAt: Date.now() }];
        },
      }),
    );
    // Cast to invoke with a tampered third arg.
    await (service.setMilestone as unknown as (
      id: OnboardingMilestoneId,
      status: 'completed' | 'skipped',
      tampered: number,
    ) => Promise<unknown>)('first_chat_sent', 'completed', 99);
    assert.equal(
      receivedArgs.length,
      2,
      'setMilestone must forward only (id, status); never a renderer timestamp',
    );
  });
});
