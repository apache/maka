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

import { deferred } from '@maka/core/test-only/async-primitives';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ConnectionCatalogEntry } from '@maka/core/runtime-policy';
import { OAuthDeviceAuthorizationExpiredError } from '@maka/runtime/oauth-provider-contracts';
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
  OAUTH_PRESENTATION_SERVICE_ID,
  OAUTH_PRESENTATION_SERVICE_VERSION,
  type ClientCapabilityServiceCallFrame,
  type OAuthLoginProjection,
} from '../protocol/index.js';
import { HostClientCapabilityCoordinator } from '../server/client-capability-coordinator.js';
import { HostOAuthCoordinator } from '../server/oauth-coordinator.js';
import { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';
import {
  clientCapabilityConnectionIdentity,
  clientCapabilityCoordinatorTestAdmission,
} from './fixtures/client-capability.js';

const NOW = 1_800_000_000_000;

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
      oauthStart('attempt-xai', fixture.connection.connectionId),
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

test('authenticated OAuth attempts reconcile by attemptId after Host restart', async () => {
  await withFixture('openai-codex', async (fixture) => {
    const client = await attachPresentation(fixture.capabilities, 'client-oauth-restart', []);
    const createCoordinator = () =>
      new HostOAuthCoordinator({
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
          deviceAuthId: 'deviceauth-restart',
          userCode: 'CODE-RESTART',
          verificationUrl: 'https://auth.openai.com/codex/device',
          expiresAt: NOW + 60_000,
          intervalMs: 1_000,
        }),
        pollCodexAuthorization: async () => ({
          authorizationCode: 'restart-code',
          codeVerifier: 'restart-verifier',
        }),
        exchangeCodexCode: async () => tokenFixture('restart-access'),
      });

    const first = createCoordinator();
    const input = oauthStart('attempt-restart', fixture.connection.connectionId);
    const started = await first.handlers['oauth.login.start'](
      input,
      operationContext('client-oauth-restart', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    const authenticated = await waitForTerminal(first, input.attemptId);
    assert.equal(authenticated.phase, 'authenticated');
    await first.close();

    const successor = createCoordinator();
    for (const operation of ['oauth.login.query', 'oauth.login.cancel'] as const) {
      const outcome = await successor.handlers[operation](
        { attemptId: input.attemptId },
        operationContext('client-oauth-restart', fixture.acquireResidency),
      );
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.deepEqual(outcome.result, authenticated);
    }
    const replay = await successor.handlers['oauth.login.start'](
      input,
      operationContext('client-oauth-restart', fixture.acquireResidency),
    );
    assert.equal(replay.ok, true);
    if (replay.ok) assert.deepEqual(replay.result, authenticated);
    const rebound = await successor.handlers['oauth.login.start'](
      {
        attemptId: input.attemptId,
        target: { kind: 'create', providerType: 'openai-codex' },
      },
      operationContext('client-oauth-restart', fixture.acquireResidency),
    );
    assert.deepEqual(rebound, {
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'OAuth attemptId is already bound to another connection',
      },
    });
    await successor.close();
    client.close();
  });
});

test('durable OAuth receipt failures stay bounded on start, query, and cancel', async () => {
  await withFixture('openai-codex', async (fixture) => {
    await writeFile(
      join(fixture.root, 'runtime-policy-oauth-login-receipts.json'),
      '{"invalid":true}\n',
      'utf8',
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
    });
    const expected = {
      ok: false as const,
      error: {
        code: 'persistence_failed' as const,
        message: 'OAuth login receipt query failed',
      },
    };
    assert.deepEqual(
      await coordinator.handlers['oauth.login.start'](
        oauthStart('attempt-receipt-failure', fixture.connection.connectionId),
        operationContext('client-receipt-failure', fixture.acquireResidency),
      ),
      expected,
    );
    for (const operation of ['oauth.login.query', 'oauth.login.cancel'] as const) {
      assert.deepEqual(
        await coordinator.handlers[operation](
          { attemptId: 'attempt-receipt-failure' },
          operationContext('client-receipt-failure', fixture.acquireResidency),
        ),
        expected,
      );
    }
    await coordinator.close();
  });
});

test('a new OAuth start conflicts with an in-progress login without cancelling it', async () => {
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
          // Park until the explicit cancel below aborts this attempt.
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
      {
        attemptId: 'attempt-first',
        target: { kind: 'create', providerType: 'xai-oauth' },
      },
      operationContext('client-xai-supersede', fixture.acquireResidency),
    );
    assert.equal(first.ok, true);
    // Wait until the first login has entered polling so #activeAttempt is set.
    for (let i = 0; i < 50 && !firstPollEntered; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(firstPollEntered, true);

    const second = await coordinator.handlers['oauth.login.start'](
      oauthStart('attempt-second', fixture.connection.connectionId),
      operationContext('client-xai-supersede', fixture.acquireResidency),
    );
    assert.deepEqual(second, {
      ok: false,
      error: { code: 'operation_conflict', message: 'Another OAuth login is already in progress' },
    });
    await coordinator.handlers['oauth.login.cancel'](
      { attemptId: 'attempt-first' },
      operationContext('client-xai-supersede', fixture.acquireResidency),
    );
    assert.equal((await waitForTerminal(coordinator, 'attempt-first')).phase, 'cancelled');
    assert.equal((await fixture.stores.connectionCatalog.getSnapshot()).connections.length, 1);
    assert.deepEqual(await fixture.stores.operations.queryInteractiveOAuthLogin('attempt-first'), {
      kind: 'not_found',
    });
    await coordinator.close();
    assert.equal(starts, 1);
    assert.equal(fixture.invalidations, 0);
    assert.equal(fixture.activeResidencies, 0);
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
        oauthStart('attempt-concurrent-a', fixture.connection.connectionId),
        operationContext('client-xai-concurrent', fixture.acquireResidency),
      ),
      coordinator.handlers['oauth.login.start'](
        oauthStart('attempt-concurrent-b', fixture.connection.connectionId),
        operationContext('client-xai-concurrent', fixture.acquireResidency),
      ),
    ]);
    assert.notEqual(first.ok, second.ok);
    const admitted = first.ok ? first : second;
    const rejected = first.ok ? second : first;
    assert.equal(admitted.ok, true);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, 'operation_conflict');
    assert.equal(maxConcurrentActive, 1, 'device authorization must not run concurrently');
    assert.equal(starts, 1);
    if (admitted.ok) {
      assert.equal(
        (await waitForTerminal(coordinator, admitted.result.attemptId)).phase,
        'authenticated',
      );
    }
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
    client.close();
  });
});

test('a committing OAuth attempt keeps exclusive admission until its granted token settles', async () => {
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
      oauthStart('attempt-deferred-first', fixture.connection.connectionId),
      operationContext('client-xai-deferred-supersede', fixture.acquireResidency),
    );
    assert.equal(first.ok, true);
    await pollAdmitted;

    const second = await coordinator.handlers['oauth.login.start'](
      oauthStart('attempt-deferred-second', fixture.connection.connectionId),
      operationContext('client-xai-deferred-supersede', fixture.acquireResidency),
    );
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, 'operation_conflict');
    releasePoll();

    assert.equal(
      (await waitForTerminal(coordinator, 'attempt-deferred-first')).phase,
      'authenticated',
      'admitted poll must still commit under a rejected competing start',
    );
    assert.equal(starts, 1);
    assert.equal(fixture.invalidations, 1);
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
      oauthStart('attempt-xai-cut', fixture.connection.connectionId),
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
      {
        attemptId: 'attempt-codex-timeout',
        target: { kind: 'create', providerType: 'openai-codex' },
      },
      operationContext('client-codex-timeout', fixture.acquireResidency),
    );
    assert.equal(started.ok, true);
    if (!started.ok) return;
    assert.deepEqual(await waitForTerminal(coordinator, 'attempt-codex-timeout'), {
      attemptId: 'attempt-codex-timeout',
      connection: started.result.connection,
      phase: 'failed',
      failure: 'authorization_failed',
    });
    assert.equal((await fixture.stores.connectionCatalog.getSnapshot()).connections.length, 1);
    assert.deepEqual(
      await fixture.stores.operations.queryInteractiveOAuthLogin('attempt-codex-timeout'),
      { kind: 'not_found' },
    );
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
      oauthStart('attempt-codex-cut', fixture.connection.connectionId),
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
      oauthStart('attempt-codex-device', fixture.connection.connectionId),
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
    const resolved = await fixture.stores.operations.resolveExecutionConnection({
      kind: 'catalog_slug',
      connectionSlug: fixture.connection.slug,
    });
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

test('OAuth login rejects a Client without presentation before creating an effect residency', async () => {
  await withFixture('openai-codex', async (fixture) => {
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
        {
          attemptId: 'attempt-missing',
          target: { kind: 'create', providerType: 'openai-codex' },
        },
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
    assert.equal((await fixture.stores.connectionCatalog.getSnapshot()).connections.length, 1);
    assert.deepEqual(
      await fixture.stores.operations.queryInteractiveOAuthLogin('attempt-missing'),
      {
        kind: 'not_found',
      },
    );
    assert.equal(fixture.activeResidencies, 0);
    await coordinator.close();
  });
});

test('OAuth login rejects an experimentally disabled provider before presentation', async () => {
  for (const provider of ['openai-codex', 'xai-oauth'] as const) {
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
            target: { kind: 'create', providerType: provider },
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
      assert.equal((await fixture.stores.connectionCatalog.getSnapshot()).connections.length, 1);
      assert.deepEqual(
        await fixture.stores.operations.queryInteractiveOAuthLogin(`attempt-disabled-${provider}`),
        { kind: 'not_found' },
      );
      assert.deepEqual(presentationCalls, []);
      assert.equal(fixture.activeResidencies, 0);
      await coordinator.close();
      client.close();
    });
  }
});

test('OAuth credential commit excludes overlapping backend activations in both directions', async () => {
  await withFixture('openai-codex', async (fixture) => {
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
      startCodexAuthorization: async () => ({
        deviceAuthId: 'deviceauth-activation',
        userCode: 'CODE-ACT',
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: NOW + 60_000,
        intervalMs: 1_000,
      }),
      pollCodexAuthorization: async () => ({
        authorizationCode: 'activation-code',
        codeVerifier: 'activation-verifier',
      }),
      exchangeCodexCode: async () => tokenFixture('gated-access'),
    });

    const started = await coordinator.handlers['oauth.login.start'](
      oauthStart('attempt-activation', fixture.connection.connectionId),
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

async function attachPresentation(
  coordinator: HostClientCapabilityCoordinator,
  connectionId: string,
  calls: string[],
  options: { authorizationDelayMs?: number } = {},
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
          admissionEvidence: { kind: 'none' },
        });
        return;
      }
      if (frame.kind !== 'client.capability.admitted') return;
      if (options.authorizationDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.authorizationDelayMs));
      }
      const call = serviceCalls.get(frame.invocationId);
      assert.ok(call);
      const structuredContent = { kind: 'presented' };
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
function operationContext(connectionId: string, acquireResidency: () => { release(): void }) {
  return {
    hostEpoch: 'host-epoch',
    connectionId,
    principal: 'local_os_user' as const,
    acquireResidency,
  };
}

async function withFixture(
  providerType: 'openai-codex' | 'xai-oauth',
  run: (fixture: {
    root: string;
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
    ...clientCapabilityCoordinatorTestAdmission(),
    activation,
    onModelToolsChanged: () => undefined,
  });
  const fixture = {
    root,
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

function oauthStart(attemptId: string, connectionId: string) {
  return { attemptId, target: { kind: 'existing' as const, connectionId } };
}
