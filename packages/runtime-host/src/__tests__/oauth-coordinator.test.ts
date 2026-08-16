import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ConnectionCatalogEntry } from '@maka/core/runtime-policy';
import { OAuthDeviceAuthorizationExpiredError } from '@maka/runtime/oauth-provider-contracts';
import { OAuthTokenEndpointError } from '@maka/runtime/oauth-login';
import {
  parseOAuthSubscriptionTokens,
  type OAuthSubscriptionTokens,
} from '@maka/runtime/subscription-credentials';
import {
  openInteractiveRuntimePolicyStoresForWrite,
  type RuntimePolicyStoresWriter,
} from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  OAUTH_PRESENTATION_AUTHORIZATION_CODE_MAX_LENGTH,
  OAUTH_PRESENTATION_SERVICE_ID,
  OAUTH_PRESENTATION_SERVICE_VERSION,
  type ClientCapabilityServiceCallFrame,
  type OAuthLoginProjection,
  type OAuthPresentationRequest,
} from '../protocol/index.js';
import { HostClientCapabilityCoordinator } from '../server/client-capability-coordinator.js';
import { HostOAuthCoordinator } from '../server/oauth-coordinator.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import { clientCapabilityConnectionIdentity } from './fixtures/client-capability.js';

const NOW = 1_800_000_000_000;

test('OAuth login uses only the initiating Client presentation service and commits Host tokens', async () => {
  await withFixture('claude-subscription', async (fixture) => {
    const presentationCalls: string[] = [];
    const first = await attachPresentation(fixture.capabilities, 'client-a', presentationCalls);
    const second = await attachPresentation(fixture.capabilities, 'client-b', presentationCalls);
    const tokens = tokenFixture('claude-access', { account_uuid: 'account-1' });
    let usageTransportClosed = 0;
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => {
        fixture.invalidations += 1;
      },
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      exchangeCode: async (input) => {
        assert.equal(input.provider, 'claude-subscription');
        assert.equal(input.code, 'authorization-code');
        return tokens;
      },
      createFetchTransport: () => ({
        fetch: async () => new Response(),
        close: async () => {
          usageTransportClosed += 1;
        },
      }),
      fetchAccountUsage: async (input) => {
        assert.equal(input.accessToken, tokens.access_token);
        return {
          fiveHour: { utilization: 12, resetsAt: '2026-08-05T12:00:00.000Z' },
          fetchedAt: NOW,
        };
      },
    });

    const started = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-a', connectionId: fixture.connection.connectionId },
      operationContext('client-b', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    const terminal = await waitForTerminal(coordinator, 'attempt-a');
    assert.equal(terminal.phase, 'authenticated');
    assert.deepEqual(presentationCalls, ['client-b']);
    assert.equal(fixture.invalidations, 1);
    const resolved = await fixture.stores.operations.resolveExecutionConnection(
      fixture.connection.slug,
    );
    assert.equal(resolved.kind, 'ready');
    if (resolved.kind === 'ready') {
      assert.deepEqual(
        parseOAuthSubscriptionTokens(resolved.secretMaterial.connection?.secret ?? ''),
        tokens,
      );
    }
    assert.deepEqual(
      await coordinator.handlers['oauth.account.usage.fetch'](
        { connectionId: fixture.connection.connectionId },
        operationContext('client-b', fixture.acquireResidency),
      ),
      {
        ok: true,
        result: {
          kind: 'available',
          provider: 'claude-subscription',
          quota: {
            fiveHour: { utilization: 12, resetsAt: '2026-08-05T12:00:00.000Z' },
            fetchedAt: NOW,
          },
        },
      },
    );
    assert.equal(usageTransportClosed, 1);
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
    first.close();
    second.close();
  });
});

test('xAI enrollment keeps device polling and credential material in the Host', async () => {
  await withFixture('xai-oauth', async (fixture) => {
    const presentationCalls: string[] = [];
    const client = await attachPresentation(fixture.capabilities, 'client-xai', presentationCalls);
    const tokens = tokenFixture('xai-access');
    let polls = 0;
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => {
        fixture.invalidations += 1;
      },
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      startXaiAuthorization: async () => ({
        deviceCode: 'host-only-device-code',
        userCode: 'USER-CODE',
        verificationUrl: 'https://accounts.x.ai/device',
        expiresAt: NOW + 60_000,
        intervalMs: 1_000,
      }),
      pollXaiAuthorization: async () => {
        polls += 1;
        return tokens;
      },
    });

    const started = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-xai', connectionId: fixture.connection.connectionId },
      operationContext('client-xai', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    const terminal = await waitForTerminal(coordinator, 'attempt-xai');
    assert.equal(terminal.phase, 'authenticated');
    assert.deepEqual(presentationCalls, ['client-xai']);
    assert.equal(polls, 1);
    assert.equal(fixture.invalidations, 1);
    await coordinator.close();
    client.close();
  });
});

test('a new OAuth start supersedes an in-progress login instead of failing with operation_conflict', async () => {
  await withFixture('xai-oauth', async (fixture) => {
    const client = await attachPresentation(fixture.capabilities, 'client-xai-supersede', []);
    let firstPollEntered = false;
    let starts = 0;
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => {
        fixture.invalidations += 1;
      },
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      startXaiAuthorization: async () => {
        starts += 1;
        return {
          deviceCode: `device-${starts}`,
          userCode: `CODE-${starts}`,
          verificationUrl: 'https://accounts.x.ai/device',
          expiresAt: NOW + 60_000,
          intervalMs: 1_000,
        };
      },
      pollXaiAuthorization: async (input) => {
        if (input.authorization.deviceCode === 'device-1') {
          firstPollEntered = true;
          // Park until supersede aborts this attempt (no external deadlock).
          await new Promise<never>((_resolve, reject) => {
            if (input.signal.aborted) {
              reject(input.signal.reason ?? new DOMException('aborted', 'AbortError'));
              return;
            }
            input.signal.addEventListener(
              'abort',
              () => {
                reject(input.signal.reason ?? new DOMException('aborted', 'AbortError'));
              },
              { once: true },
            );
          });
        }
        return tokenFixture('xai-second');
      },
    });

    const first = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-first', connectionId: fixture.connection.connectionId },
      operationContext('client-xai-supersede', fixture.acquireResidency),
    );
    assert.equal(first.ok, true);
    // Wait until the first login has entered polling so #activeAttempt is set.
    for (let i = 0; i < 50 && !firstPollEntered; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(firstPollEntered, true);

    const second = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-second', connectionId: fixture.connection.connectionId },
      operationContext('client-xai-supersede', fixture.acquireResidency),
    );
    assert.equal(second.ok, true, 'second start must supersede, not conflict');
    if (second.ok) assert.equal(second.result.attemptId, 'attempt-second');

    assert.equal((await waitForTerminal(coordinator, 'attempt-first')).phase, 'cancelled');
    assert.equal((await waitForTerminal(coordinator, 'attempt-second')).phase, 'authenticated');
    assert.equal(starts, 2);
    assert.equal(fixture.invalidations, 1);
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
    client.close();
  });
});

test('concurrent OAuth starts serialize and never dual-open active logins', async () => {
  await withFixture('xai-oauth', async (fixture) => {
    const client = await attachPresentation(fixture.capabilities, 'client-xai-concurrent', []);
    let concurrentActive = 0;
    let maxConcurrentActive = 0;
    let starts = 0;
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => {
        fixture.invalidations += 1;
      },
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      startXaiAuthorization: async () => {
        starts += 1;
        concurrentActive += 1;
        maxConcurrentActive = Math.max(maxConcurrentActive, concurrentActive);
        // Yield so a racing start would observe dual activity without a gate.
        await new Promise((resolve) => setTimeout(resolve, 15));
        concurrentActive -= 1;
        return {
          deviceCode: `device-${starts}`,
          userCode: `CODE-${starts}`,
          verificationUrl: 'https://accounts.x.ai/device',
          expiresAt: NOW + 60_000,
          intervalMs: 1_000,
        };
      },
      pollXaiAuthorization: async (input) => {
        if (input.signal.aborted) {
          throw input.signal.reason ?? new DOMException('aborted', 'AbortError');
        }
        return tokenFixture(`xai-concurrent-${input.authorization.deviceCode}`);
      },
    });

    const [first, second] = await Promise.all([
      coordinator.handlers['oauth.login.start'](
        { attemptId: 'attempt-concurrent-a', connectionId: fixture.connection.connectionId },
        operationContext('client-xai-concurrent', fixture.acquireResidency),
      ),
      coordinator.handlers['oauth.login.start'](
        { attemptId: 'attempt-concurrent-b', connectionId: fixture.connection.connectionId },
        operationContext('client-xai-concurrent', fixture.acquireResidency),
      ),
    ]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(maxConcurrentActive, 1, 'device authorization must not run concurrently');
    assert.equal(starts, 2);

    const phases = await Promise.all([
      waitForTerminal(coordinator, 'attempt-concurrent-a'),
      waitForTerminal(coordinator, 'attempt-concurrent-b'),
    ]);
    // First is superseded while polling or still completing; second should authenticate.
    assert.ok(phases.some((phase) => phase.phase === 'authenticated'));
    assert.ok(
      phases.every((phase) => phase.phase === 'authenticated' || phase.phase === 'cancelled'),
    );
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
    client.close();
  });
});

test('supersede waits for an admitted token poll instead of dropping the granted token', async () => {
  await withFixture('xai-oauth', async (fixture) => {
    const client = await attachPresentation(
      fixture.capabilities,
      'client-xai-deferred-supersede',
      [],
    );
    let markPollAdmitted!: () => void;
    const pollAdmitted = new Promise<void>((resolve) => {
      markPollAdmitted = resolve;
    });
    let releasePoll!: () => void;
    const pollRelease = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    let starts = 0;
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => {
        fixture.invalidations += 1;
      },
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      startXaiAuthorization: async () => {
        starts += 1;
        return {
          deviceCode: `device-${starts}`,
          userCode: `CODE-${starts}`,
          verificationUrl: 'https://accounts.x.ai/device',
          expiresAt: NOW + 60_000,
          intervalMs: 1_000,
        };
      },
      pollXaiAuthorization: async (input) => {
        if (input.authorization.deviceCode === 'device-1') {
          input.onPollAdmission?.();
          markPollAdmitted();
          await pollRelease;
          return tokenFixture('xai-first-admitted');
        }
        return tokenFixture('xai-second-after-wait');
      },
    });

    const first = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-deferred-first', connectionId: fixture.connection.connectionId },
      operationContext('client-xai-deferred-supersede', fixture.acquireResidency),
    );
    assert.equal(first.ok, true);
    await pollAdmitted;

    const secondPromise = coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-deferred-second', connectionId: fixture.connection.connectionId },
      operationContext('client-xai-deferred-supersede', fixture.acquireResidency),
    );
    // Give supersede time to observe cancellationDeferred and park on settlement.
    await new Promise((resolve) => setTimeout(resolve, 20));
    releasePoll();

    assert.equal(
      (await waitForTerminal(coordinator, 'attempt-deferred-first')).phase,
      'authenticated',
      'admitted poll must still commit under supersede',
    );
    const second = await secondPromise;
    assert.equal(second.ok, true);
    assert.equal(
      (await waitForTerminal(coordinator, 'attempt-deferred-second')).phase,
      'authenticated',
    );
    assert.equal(starts, 2);
    assert.equal(fixture.invalidations, 2);
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
    client.close();
  });
});

test('xAI cancellation waits for an admitted token poll and commits its successful outcome', async () => {
  await withFixture('xai-oauth', async (fixture) => {
    const client = await attachPresentation(fixture.capabilities, 'client-xai-cut', []);
    let markPollAdmitted!: () => void;
    const pollAdmitted = new Promise<void>((resolve) => {
      markPollAdmitted = resolve;
    });
    let releasePoll!: () => void;
    const pollRelease = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => {
        fixture.invalidations += 1;
      },
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      startXaiAuthorization: async () => ({
        deviceCode: 'host-only-device-code',
        userCode: 'USER-CODE',
        verificationUrl: 'https://accounts.x.ai/device',
        expiresAt: NOW + 60_000,
        intervalMs: 1_000,
      }),
      pollXaiAuthorization: async (input) => {
        input.onPollAdmission?.();
        markPollAdmitted();
        await pollRelease;
        return tokenFixture('xai-after-cancel');
      },
    });

    const started = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-xai-cut', connectionId: fixture.connection.connectionId },
      operationContext('client-xai-cut', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    await pollAdmitted;
    const cancelled = await coordinator.handlers['oauth.login.cancel'](
      { attemptId: 'attempt-xai-cut' },
      operationContext('client-xai-cut', fixture.acquireResidency),
    );
    assert.equal(cancelled.ok, true);
    if (cancelled.ok) assert.equal(cancelled.result.phase, 'exchanging');
    releasePoll();
    assert.equal((await waitForTerminal(coordinator, 'attempt-xai-cut')).phase, 'authenticated');
    assert.equal(fixture.invalidations, 1);
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
    client.close();
  });
});

test('Codex device login fails when approval never arrives before expiry', async () => {
  await withFixture('openai-codex', async (fixture) => {
    const client = await attachPresentation(fixture.capabilities, 'client-codex-timeout', []);
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => undefined,
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      startCodexAuthorization: async () => ({
        deviceAuthId: 'deviceauth-expired',
        userCode: 'CODE-1234',
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: NOW - 1,
        intervalMs: 1_000,
      }),
      pollCodexAuthorization: async (input) => {
        input.onPollAdmission?.();
        // The real poll throws OAuthDeviceAuthorizationExpiredError when the
        // device window elapses without approval — a timeout, not a
        // provider rejection of the account.
        throw new OAuthDeviceAuthorizationExpiredError();
      },
      exchangeCodexCode: async () => {
        throw new Error('OAuth exchange must not start');
      },
    });

    const started = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-codex-timeout', connectionId: fixture.connection.connectionId },
      operationContext('client-codex-timeout', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    assert.deepEqual(await waitForTerminal(coordinator, 'attempt-codex-timeout'), {
      attemptId: 'attempt-codex-timeout',
      connectionId: fixture.connection.connectionId,
      provider: 'openai-codex',
      phase: 'failed',
      failure: 'authorization_failed',
    });
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
    client.close();
  });
});

test('Codex device login cancels between polls but commits an admitted poll result', async () => {
  await withFixture('openai-codex', async (fixture) => {
    const client = await attachPresentation(fixture.capabilities, 'client-codex-cut', []);
    let markPollAdmitted!: () => void;
    const pollAdmitted = new Promise<void>((resolve) => {
      markPollAdmitted = resolve;
    });
    let releasePoll!: () => void;
    const pollRelease = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => {
        fixture.invalidations += 1;
      },
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      startCodexAuthorization: async () => ({
        deviceAuthId: 'deviceauth-cut',
        userCode: 'CODE-CUT',
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: NOW + 60_000,
        intervalMs: 1_000,
      }),
      pollCodexAuthorization: async (input) => {
        input.onPollAdmission?.();
        markPollAdmitted();
        await pollRelease;
        return { authorizationCode: 'device-cut-code', codeVerifier: 'device-cut-verifier' };
      },
      exchangeCodexCode: async () => tokenFixture('codex-after-cancel'),
    });

    const started = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-codex-cut', connectionId: fixture.connection.connectionId },
      operationContext('client-codex-cut', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    await pollAdmitted;
    const cancelled = await coordinator.handlers['oauth.login.cancel'](
      { attemptId: 'attempt-codex-cut' },
      operationContext('client-codex-cut', fixture.acquireResidency),
    );
    assert.equal(cancelled.ok, true);
    if (cancelled.ok) assert.equal(cancelled.result.phase, 'exchanging');
    releasePoll();
    assert.equal((await waitForTerminal(coordinator, 'attempt-codex-cut')).phase, 'authenticated');
    assert.equal(fixture.invalidations, 1);
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
    client.close();
  });
});

test('Codex device login presents the one-time code and commits exchanged tokens', async () => {
  await withFixture('openai-codex', async (fixture) => {
    const presentationCalls: string[] = [];
    const presentationInputs: Array<{ connectionId: string; input: Record<string, unknown> }> = [];
    const client = await attachPresentation(
      fixture.capabilities,
      'client-codex-device',
      presentationCalls,
      {},
      presentationInputs,
    );
    const tokens = tokenFixture('codex-device-access');
    let polls = 0;
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => {
        fixture.invalidations += 1;
      },
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      startCodexAuthorization: async () => ({
        deviceAuthId: 'deviceauth-host-only',
        userCode: 'CODE-9XYZ',
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: NOW + 60_000,
        intervalMs: 1_000,
      }),
      pollCodexAuthorization: async () => {
        polls += 1;
        return { authorizationCode: 'device-auth-code', codeVerifier: 'device-verifier' };
      },
      exchangeCodexCode: async (input) => {
        assert.equal(input.grant.authorizationCode, 'device-auth-code');
        assert.equal(input.grant.codeVerifier, 'device-verifier');
        return tokens;
      },
    });

    const started = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-codex-device', connectionId: fixture.connection.connectionId },
      operationContext('client-codex-device', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    const terminal = await waitForTerminal(coordinator, 'attempt-codex-device');
    assert.equal(terminal.phase, 'authenticated');
    // The one-time code is surfaced to the presenting Client via stateHint.
    assert.deepEqual(presentationInputs, [
      {
        connectionId: 'client-codex-device',
        input: {
          url: 'https://auth.openai.com/codex/device',
          stateHint: 'CODE-9XYZ',
        },
      },
    ]);
    assert.equal(polls, 1);
    assert.equal(fixture.invalidations, 1);
    assert.equal(fixture.activeResidencies, 0);
    const resolved = await fixture.stores.operations.resolveExecutionConnection(
      fixture.connection.slug,
    );
    assert.equal(resolved.kind, 'ready');
    if (resolved.kind === 'ready') {
      assert.deepEqual(
        parseOAuthSubscriptionTokens(resolved.secretMaterial.connection?.secret ?? ''),
        tokens,
      );
    }
    await coordinator.close();
    client.close();
  });
});

test('OAuth login rejects an oversized authorization code at the Host boundary', async () => {
  await withFixture('claude-subscription', async (fixture) => {
    const client = await attachPresentation(fixture.capabilities, 'client-oversized', [], {
      authorizationCode: 'x'.repeat(OAUTH_PRESENTATION_AUTHORIZATION_CODE_MAX_LENGTH + 1),
    });
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => {
        fixture.invalidations += 1;
      },
      onFatal: (error) => {
        throw error;
      },
      exchangeCode: async () => {
        throw new Error('OAuth exchange must not start');
      },
    });

    const started = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-oversized', connectionId: fixture.connection.connectionId },
      operationContext('client-oversized', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    assert.deepEqual(await waitForTerminal(coordinator, 'attempt-oversized'), {
      attemptId: 'attempt-oversized',
      connectionId: fixture.connection.connectionId,
      provider: 'claude-subscription',
      phase: 'failed',
      failure: 'authorization_failed',
    });
    assert.equal(fixture.invalidations, 0);
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
    client.close();
  });
});

test('OAuth login rejects a Client without presentation before creating an effect residency', async () => {
  await withFixture('claude-subscription', async (fixture) => {
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => undefined,
      onFatal: (error) => {
        throw error;
      },
    });
    assert.deepEqual(
      await coordinator.handlers['oauth.login.start'](
        { attemptId: 'attempt-missing', connectionId: fixture.connection.connectionId },
        operationContext('client-missing', fixture.acquireResidency),
      ),
      {
        ok: false,
        error: {
          code: 'capability_unavailable',
          message: 'Initiating Client cannot present this OAuth login',
        },
      },
    );
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
  });
});

test('OAuth login rejects an experimentally disabled provider before presentation', async () => {
  for (const provider of ['claude-subscription', 'openai-codex'] as const) {
    await withFixture(provider, async (fixture) => {
      const presentationCalls: string[] = [];
      const client = await attachPresentation(
        fixture.capabilities,
        `client-disabled-${provider}`,
        presentationCalls,
      );
      const coordinator = new HostOAuthCoordinator({
        runtimePolicy: fixture.stores,
        activation: fixture.activation,
        clientCapabilities: fixture.capabilities,
        isProviderEnabled: (candidate) => candidate !== provider,
        acquireResidency: fixture.acquireResidency,
        invalidateBackends: async () => undefined,
        onFatal: (error) => {
          throw error;
        },
      });

      assert.deepEqual(
        await coordinator.handlers['oauth.login.start'](
          {
            attemptId: `attempt-disabled-${provider}`,
            connectionId: fixture.connection.connectionId,
          },
          operationContext(`client-disabled-${provider}`, fixture.acquireResidency),
        ),
        {
          ok: false,
          error: {
            code: 'operation_unavailable',
            message: 'OAuth enrollment is disabled for this provider',
          },
        },
      );
      assert.deepEqual(presentationCalls, []);
      assert.equal(fixture.activeResidencies, 0);
      await coordinator.close();
      client.close();
    });
  }
});

test('OAuth credential commit excludes overlapping backend activations in both directions', async () => {
  await withFixture('claude-subscription', async (fixture) => {
    const client = await attachPresentation(fixture.capabilities, 'client-activation', []);
    const precedingActivationEntered = deferred();
    const releasePrecedingActivation = deferred();
    const precedingActivation = fixture.activation.runBackendActivation(async () => {
      precedingActivationEntered.resolve();
      await releasePrecedingActivation.promise;
    });
    await precedingActivationEntered.promise;

    const invalidationEntered = deferred();
    const releaseInvalidation = deferred();
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => {
        fixture.invalidations += 1;
        invalidationEntered.resolve();
        await releaseInvalidation.promise;
      },
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      exchangeCode: async () => tokenFixture('gated-access', { account_uuid: 'account-1' }),
    });

    const started = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-activation', connectionId: fixture.connection.connectionId },
      operationContext('client-activation', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    await waitForPhase(coordinator, 'attempt-activation', 'committing');
    assert.equal(fixture.invalidations, 0);

    let laterActivationEntered = false;
    const laterActivation = fixture.activation.runBackendActivation(() => {
      laterActivationEntered = true;
    });
    releasePrecedingActivation.resolve();
    await invalidationEntered.promise;
    assert.equal(laterActivationEntered, false);

    releaseInvalidation.resolve();
    assert.equal((await waitForTerminal(coordinator, 'attempt-activation')).phase, 'authenticated');
    await Promise.all([precedingActivation, laterActivation]);
    assert.equal(laterActivationEntered, true);
    await coordinator.close();
    client.close();
  });
});

test('paste-code presentation can outlive the generic Client Capability timeout', async (t) => {
  await withFixture('claude-subscription', async (fixture) => {
    const presentationCalls: string[] = [];
    const client = await attachPresentation(
      fixture.capabilities,
      'client-slow-paste',
      presentationCalls,
      { authorizationDelayMs: 150_001 },
    );
    const coordinator = new HostOAuthCoordinator({
      runtimePolicy: fixture.stores,
      activation: fixture.activation,
      clientCapabilities: fixture.capabilities,
      isProviderEnabled: () => true,
      acquireResidency: fixture.acquireResidency,
      invalidateBackends: async () => undefined,
      onFatal: (error) => {
        throw error;
      },
      now: () => NOW,
      exchangeCode: async () => tokenFixture('slow-access', { account_uuid: 'account-1' }),
    });

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const started = await coordinator.handlers['oauth.login.start'](
      { attemptId: 'attempt-slow-paste', connectionId: fixture.connection.connectionId },
      operationContext('client-slow-paste', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    assert.deepEqual(presentationCalls, ['client-slow-paste']);
    t.mock.timers.tick(150_001);
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
    t.mock.timers.reset();

    assert.equal((await waitForTerminal(coordinator, 'attempt-slow-paste')).phase, 'authenticated');
    await coordinator.close();
    client.close();
  });
});

async function attachPresentation(
  coordinator: HostClientCapabilityCoordinator,
  connectionId: string,
  calls: string[],
  options: { authorizationCode?: string; authorizationDelayMs?: number } = {},
  inputCalls?: Array<{ connectionId: string; input: Record<string, unknown> }>,
) {
  const serviceCalls = new Map<string, ClientCapabilityServiceCallFrame>();
  let connection!: ReturnType<HostClientCapabilityCoordinator['attachConnection']>;
  connection = coordinator.attachConnection(clientCapabilityConnectionIdentity(connectionId), {
    send: async (frame) => {
      if (frame.kind === 'client.capability.service_call') {
        calls.push(connectionId);
        if (inputCalls) inputCalls.push({ connectionId, input: frame.input });
        serviceCalls.set(frame.invocationId, frame);
        connection.accept({
          kind: 'client.capability.accepted',
          invocationId: frame.invocationId,
        });
        return;
      }
      if (frame.kind !== 'client.capability.admitted') return;
      if (options.authorizationDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.authorizationDelayMs));
      }
      const call = serviceCalls.get(frame.invocationId);
      assert.ok(call);
      const structuredContent =
        call.method === 'request_authorization_code'
          ? {
              kind: 'authorization_code',
              authorizationCode:
                options.authorizationCode ??
                `authorization-code#${new URL(String(call.input.url)).searchParams.get('state')}`,
            }
          : { kind: 'presented' };
      connection.accept({
        kind: 'client.capability.result',
        invocationId: frame.invocationId,
        result: { content: [], structuredContent },
      });
    },
  });
  const registered = await coordinator.handlers['client.capability.replace'](
    {
      registrationId: `registration-${connectionId}`,
      offers: [],
      services: [
        {
          serviceId: OAUTH_PRESENTATION_SERVICE_ID,
          version: OAUTH_PRESENTATION_SERVICE_VERSION,
        },
      ],
    },
    operationContext(connectionId, () => ({ release() {} })),
  );
  assert.equal(registered.ok, true);
  return connection;
}

async function waitForTerminal(
  coordinator: HostOAuthCoordinator,
  attemptId: string,
): Promise<OAuthLoginProjection> {
  for (let index = 0; index < 200; index += 1) {
    const outcome = await coordinator.handlers['oauth.login.query'](
      { attemptId },
      operationContext('query-client', () => ({ release() {} })),
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok && ['authenticated', 'cancelled', 'failed'].includes(outcome.result.phase)) {
      return outcome.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('OAuth login did not settle');
}

async function waitForPhase(
  coordinator: HostOAuthCoordinator,
  attemptId: string,
  phase: OAuthLoginProjection['phase'],
): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    const outcome = await coordinator.handlers['oauth.login.query'](
      { attemptId },
      operationContext('query-client', () => ({ release() {} })),
    );
    assert.equal(outcome.ok, true);
    if (outcome.ok && outcome.result.phase === phase) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`OAuth login did not enter ${phase}`);
}

function tokenFixture(
  accessToken: string,
  extra: Partial<OAuthSubscriptionTokens> = {},
): OAuthSubscriptionTokens {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-token',
    expires_at: NOW + 3_600_000,
    ...extra,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function operationContext(connectionId: string, acquireResidency: () => { release(): void }) {
  return {
    hostEpoch: 'host-epoch',
    connectionId,
    surface: 'desktop' as const,
    principal: 'local_os_user' as const,
    acquireResidency,
  };
}

async function withFixture(
  providerType: 'claude-subscription' | 'openai-codex' | 'xai-oauth',
  run: (fixture: {
    stores: RuntimePolicyStoresWriter;
    connection: ConnectionCatalogEntry;
    capabilities: HostClientCapabilityCoordinator;
    activation: RuntimePolicyActivationGate;
    acquireResidency: () => { release(): void };
    activeResidencies: number;
    invalidations: number;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-oauth-coordinator-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) return;
  const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
  const created = await stores.connectionCatalog.create({
    expectedCatalogRevision: 0,
    connection: {
      slug: `${providerType}-fixture`,
      name: providerType,
      providerType,
      enabled: true,
      enabledModelIds: ['fixture-model'],
    },
  });
  assert.equal(created.kind, 'committed');
  if (created.kind !== 'committed') return;
  const connection = created.snapshot.connections[0];
  assert.ok(connection);
  const activation = new RuntimePolicyActivationGate();
  const capabilities = new HostClientCapabilityCoordinator({
    activation,
    onModelToolsChanged: () => undefined,
  });
  const fixture = {
    stores,
    connection,
    capabilities,
    activation,
    activeResidencies: 0,
    invalidations: 0,
    acquireResidency() {
      fixture.activeResidencies += 1;
      let released = false;
      return {
        release() {
          if (released) throw new Error('residency released twice');
          released = true;
          fixture.activeResidencies -= 1;
        },
      };
    },
  };
  try {
    await run(fixture);
  } finally {
    await capabilities.close();
    if (!owner.closed) await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}
