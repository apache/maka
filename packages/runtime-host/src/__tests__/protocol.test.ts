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

import { RuntimeHostProtocolError } from '../protocol/errors.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { CONTEXT_BUDGET_EXHAUSTED_DETAILS, TOOL_OUTPUT_DELTA_MAX_CHARS } from '@maka/core/events';
import { CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS } from '@maka/core/runtime-policy';
import {
  decodeClientCapabilityReplaceInput,
  decodeClientFrame,
  decodeHostFrame,
  decodeHostRegistration,
  decodeSessionMessageQueueProjection,
  decodeSessionContinuitySnapshot,
  encodeProtocolMessage,
  HOST_OPERATION_SPECS,
  MESSAGE_OPERATION_RESULT_MAX_BYTES,
  MESSAGE_QUEUE_MAX_ENTRIES,
  negotiateProtocol,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  RUNTIME_HOST_PROTOCOL_VERSION,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES,
  SESSION_LIVE_DELTA_MAX_BYTES,
  SESSION_TOOL_OUTPUT_DELTA_MAX_BYTES,
  SESSION_TOOL_NAME_MAX_BYTES,
  SUBSCRIPTION_OPEN_RESULT_MAX_BYTES,
  TURN_MESSAGE_CONTENT_MAX_BYTES,
  TURN_MESSAGE_TEXT_MAX_BYTES,
  RUNTIME_POLICY_OPERATION_SPECS,
} from '../protocol/index.js';
import { HOST_BOOTSTRAP_OPERATION_SPECS } from '../protocol/host-status.js';
import { composeOperationSpecMaps } from '../protocol/operation-spec.js';
import {
  RUNTIME_HOST_DIAGNOSTIC_LOG_MAX_BYTES,
  runtimeHostLogBuffer,
} from '../process-diagnostics.js';
import {
  TURN_MESSAGE_QUOTE_LABEL_MAX_LENGTH,
  TURN_MESSAGE_QUOTE_MAX_COUNT,
  TURN_MESSAGE_QUOTE_TEXT_MAX_LENGTH,
  TURN_FAILURE_MESSAGE_MAX_BYTES,
  decodeMessageContent,
  TURN_SKILL_ID_MAX_COUNT,
  TURN_SKILL_ID_MAX_LENGTH,
} from '../protocol/turn.js';

describe('Runtime Host bootstrap protocol', () => {
  test('accepts only authenticated-listener registration endpoints on IPv4 loopback', () => {
    const registration = {
      kind: 'maka-runtime-host',
      schemaVersion: 1,
      rootId: 'a'.repeat(64),
      hostEpoch: 'host-epoch',
      endpoint: '/tmp/runtime-host.sock',
      websocketEndpoints: ['ws://127.0.0.1:43210/runtime-host'],
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      compositionId: 'maka.interactive',
      compositionRevision: 'revision',
      lifecycleMode: 'ephemeral',
      state: 'ready',
      pid: 1234,
      createdAt: new Date(0).toISOString(),
    } as const;
    assert.deepEqual(decodeHostRegistration(registration).websocketEndpoints, [
      'ws://127.0.0.1:43210/runtime-host',
    ]);
    assert.throws(() =>
      decodeHostRegistration({
        ...registration,
        websocketEndpoints: ['ws://0.0.0.0:43210/runtime-host'],
      }),
    );
    assert.throws(() =>
      decodeHostRegistration({
        ...registration,
        websocketEndpoints: ['ws://127.0.0.1:43210/runtime-host?credential=secret'],
      }),
    );
  });

  test('decodes a Client hello without a surface identity', () => {
    const hello = {
      kind: 'hello',
      clientInstanceId: 'client-without-surface',
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      compositionId: 'maka.interactive',
    } as const;

    assert.deepEqual(decodeClientFrame(hello), hello);
  });

  test('ignores a legacy surface identity while decoding a Client hello', () => {
    const hello = {
      kind: 'hello',
      clientInstanceId: 'legacy-surface-client',
      surface: 'tui',
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
      compositionId: 'maka.interactive',
    } as const;

    const { surface: _legacySurface, ...expected } = hello;
    assert.deepEqual(decodeClientFrame(hello), expected);
  });

  test('publishes a new compatibility epoch for Session catalog live-run state', () => {
    // Epoch 22 predates the live-run projection and rejects its added catalog
    // field, so mixed-version peers must fail during the handshake instead.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 22);
  });

  test('rejects the legacy connection update result in the current compatibility epoch', () => {
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'connection-update-legacy',
          operation: 'connection.catalog.update',
          ok: true,
          result: {
            kind: 'invalid_default_target',
            target: { connectionId: '2a42da77-afac-4fb1-bff1-e7d6e6e55e9f', modelId: 'gpt-5' },
          },
        }),
      isInvalidFrame,
    );
  });

  test('publishes a new compatibility epoch for external Session import state', () => {
    // Epoch 25 added authoritative live run state. Requiring importState on
    // external catalog items is another closed wire-schema change, so Clients
    // and Hosts from epoch 25 must fail the handshake instead of decoding each
    // other's catalog responses asymmetrically.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 25);
  });

  test('publishes a new compatibility epoch for sandbox failure results', () => {
    // Epoch 32 rejects the bounded sandbox failure reason on live tool results,
    // so mixed-version peers must fail the handshake. Asserted as a floor, like
    // the epochs above: pinning an exact value breaks on every later bump.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 32);
  });

  test('publishes a new compatibility epoch for backend-free ScheduledTask templates', () => {
    // Epoch 33 Clients require the `backend` field these templates no longer
    // emit. Also a floor, for the same reason as above.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 33);
  });

  test('publishes a new compatibility epoch for Session trace pagination', () => {
    // Epoch 34 peers cannot exchange the paged trace and usage frames. Also a
    // floor, for the same reason as above.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 34);
  });

  test('publishes a new compatibility epoch for TraceTotals removal', () => {
    // Epoch 35 peers still transport aggregate TraceTotals. Also a floor, for
    // the same reason as above.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 35);
  });

  test('publishes a new compatibility epoch for the catalog search term', () => {
    // Epoch 36 cannot carry the search term. Also a floor, for the same reason
    // as above.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 36);
  });

  test('publishes a new compatibility epoch for the retired execute permission mode', () => {
    // Epoch 37 still speaks `execute`. Frame decoders now reject it, so such a
    // peer would fail mid-Session rather than at connect.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 37);
  });

  test('publishes a new compatibility epoch for Client Capability progress', () => {
    // Epoch 38 peers reject the additional tool descriptor field and progress
    // frame, so the capability must be negotiated at a newer epoch.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 38);
  });

  test('publishes a new compatibility epoch for onboarding endpoint overrides', () => {
    // Epoch 44 peers reject the required `baseUrl` and `connectionId` on
    // onboarding inputs, and the `base_url_not_configured` /
    // `connection_not_found` rejections on their results. Both landed in one
    // epoch because neither shape was ever published separately.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 44);
  });

  test('publishes a new compatibility epoch for explicit onboarding targets', () => {
    // Epoch 51 peers require nullable connectionId targeting and decode a
    // successful save without its committed Connection identity.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 52);
  });

  test('publishes a new compatibility epoch for explicit OAuth Connection targets', () => {
    // Epoch 53 peers still send connectionId directly and receive provider plus
    // connectionId fields instead of one canonical Connection identity.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 53);
  });

  test('publishes a new compatibility epoch for queued message editing', () => {
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 45);
  });

  test('publishes a new compatibility epoch for the project registration preference', () => {
    // Epoch 46 Hosts reject the optional preference field on the closed register
    // input, so mixed-version peers must fail during the handshake instead.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 46);
  });

  test('publishes a new compatibility epoch for Side Conversation copy intent', () => {
    // Epoch 47 belongs to project registration preferences on current main.
    // Side Conversation adds another closed branch-copy input and therefore
    // needs its own later handshake boundary.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 47);
  });

  test('publishes a new compatibility epoch for context-budget failure detail', () => {
    // Epoch 50 is already used by WorkHub coordination summaries on main.
    // The context-budget detail therefore needs its own strictly newer
    // handshake boundary so peers cannot accept the wrong closed shape.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 50);
  });

  test('publishes a new compatibility epoch for the removed execution.inspect.resolve operation', () => {
    // Epoch 63 peers still know execution.inspect.resolve and would send it
    // only to fail mid-connection now that it is gone, so its removal must
    // fail the handshake instead.
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 63);
    assert.equal(Object.hasOwn(HOST_OPERATION_SPECS, 'execution.inspect.resolve'), false);
    assert.equal(Object.hasOwn(HOST_OPERATION_SPECS, 'execution.inspect.query'), true);
  });

  test('adds credential rotation without changing existing credential inputs', () => {
    const issueInput = {
      principalKind: 'remote_owner',
      principalId: 'desktop:test',
      operationGrants: ['host.status'],
      canPublishClientCapabilities: false,
      canUseHostPaths: false,
    };
    assert.deepEqual(
      HOST_OPERATION_SPECS['access.credential.prepare'].decodeInput(issueInput),
      issueInput,
    );
    assert.deepEqual(
      HOST_OPERATION_SPECS['access.credential.prepare'].decodeInput({
        ...issueInput,
        bindClientInstance: true,
      }),
      { ...issueInput, bindClientInstance: true },
    );
    assert.deepEqual(
      HOST_OPERATION_SPECS['access.credential.finalize'].decodeOutput({
        reconnectRequired: true,
      }),
      { reconnectRequired: true },
    );
    assert.throws(() =>
      HOST_OPERATION_SPECS['access.credential.prepare'].decodeInput({
        replacementOfCredentialId: 'credential-current',
      }),
    );
    assert.throws(() =>
      HOST_OPERATION_SPECS['access.credential.revoke'].decodeInput({
        credentialId: 'credential-target',
        requiredActiveCredentialId: 'credential-current',
      }),
    );
    assert.deepEqual(
      HOST_OPERATION_SPECS['access.credential.rotation.prepare'].decodeInput({
        replacementOfCredentialId: 'credential-current',
      }),
      { replacementOfCredentialId: 'credential-current' },
    );
    assert.deepEqual(
      HOST_OPERATION_SPECS['access.credential.rotation.revoke'].decodeInput({
        credentialId: 'credential-target',
        requiredActiveCredentialId: 'credential-current',
      }),
      {
        credentialId: 'credential-target',
        requiredActiveCredentialId: 'credential-current',
      },
    );
  });

  test('decodes Host-bound capability-provider ownership at a new compatibility boundary', () => {
    const input = {
      principalKind: 'capability_provider',
      principalId: 'terminal-mcp-provider',
      operationGrants: ['client.capability.replace', 'client.capability.unregister'],
      canPublishClientCapabilities: true,
      canUseHostPaths: false,
      capabilityOwnerCredentialId: 'terminal-owner-credential',
    };
    assert.deepEqual(HOST_OPERATION_SPECS['access.credential.issue'].decodeInput(input), input);
    assert.throws(() =>
      HOST_OPERATION_SPECS['access.credential.prepare'].decodeInput({
        ...input,
        bindClientInstance: true,
      }),
    );
    const output = {
      credentialId: 'provider-credential',
      deliveryId: 'provider-delivery',
      principalKind: 'capability_provider',
      principalId: 'terminal-mcp-provider',
      operationGrants: ['client.capability.replace', 'client.capability.unregister'],
      canPublishClientCapabilities: true,
      canUseHostPaths: false,
      capabilityOwner: {
        principalId: 'terminal-owner',
        clientInstanceId: 'terminal-client',
      },
    };
    assert.deepEqual(HOST_OPERATION_SPECS['access.credential.issue'].decodeOutput(output), output);
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 67);
  });

  test('decodes atomic principal revocation and publishes its compatibility boundary', () => {
    assert.deepEqual(
      HOST_OPERATION_SPECS['access.principal.revoke'].decodeInput({
        principalKind: 'remote_owner',
        principalId: 'desktop-owner:local-sharing',
      }),
      {
        principalKind: 'remote_owner',
        principalId: 'desktop-owner:local-sharing',
      },
    );
    assert.deepEqual(
      HOST_OPERATION_SPECS['access.principal.revoke'].decodeOutput({ revoked: true }),
      { revoked: true },
    );
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 54);
  });

  test('publishes a new compatibility epoch for Client-bound pairing claims', () => {
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 53);
  });

  test('publishes a new compatibility epoch for provider capacity retry progress', () => {
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 41);
  });

  test('publishes a new compatibility epoch for shell-run poll correlation', () => {
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 42);
  });

  test('publishes a new compatibility epoch for the retired Session timestamp', () => {
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 43);
  });

  test('publishes a new compatibility epoch for durable Message lifecycle queries', () => {
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 50);
  });

  test('publishes a new compatibility epoch for Message execution ownership', () => {
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 61);
  });

  test('publishes a new compatibility epoch for exact Session Connection identity', () => {
    assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 56);
  });

  test('selects the highest mutually supported protocol and rejects a gap', () => {
    assert.equal(negotiateProtocol({ min: 0, max: 0 }, { min: 0, max: 0 }), 0);
    assert.equal(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 4 }), 3);
    assert.equal(negotiateProtocol({ min: 0, max: 0 }, { min: 1, max: 1 }), undefined);
    assert.throws(() => negotiateProtocol({ min: -1, max: 0 }, { min: 0, max: 0 }), isInvalidFrame);
  });

  test('keeps the subscription queue Epoch correlated', () => {
    assert.equal(SESSION_CONTINUITY_SCHEMA_VERSION, 5);
    const opened = {
      requestId: 'open-1',
      operation: 'subscription.open',
      ok: true,
      result: {
        hostEpoch: 'epoch-1',
        subscriptionId: 'subscription-1',
        nextSequence: 1,
        activeAssistantStreams: [{ kind: 'thinking', turnId: 'turn-1', messageId: 'message-1' }],
        transcript: null,
        snapshot: continuitySnapshot('epoch-1'),
      },
    };
    assert.deepEqual(decodeHostFrame(opened), opened);
    assert.throws(
      () =>
        decodeHostFrame({
          ...opened,
          result: {
            ...opened.result,
            activeAssistantStreams: [
              ...opened.result.activeAssistantStreams,
              ...opened.result.activeAssistantStreams,
            ],
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...opened,
          result: { ...opened.result, snapshot: continuitySnapshot('epoch-2') },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeSessionContinuitySnapshot({
          ...continuitySnapshot('epoch-1'),
          interactions: [],
        }),
      isInvalidFrame,
    );
    const waiting = {
      ...continuitySnapshot('epoch-1'),
      rootTurn: {
        ...continuitySnapshot('epoch-1').rootTurn,
        status: 'waiting_for_user',
      },
    };
    assert.deepEqual(decodeSessionContinuitySnapshot(waiting), waiting);
    const retrying = {
      ...continuitySnapshot('epoch-1'),
      rootTurn: {
        ...continuitySnapshot('epoch-1').rootTurn,
        providerRetry: {
          phase: 'scheduled' as const,
          attempt: 8,
          maxAttempts: 10,
          delayMs: 40_000,
          reason: 'rate_limit' as const,
        },
      },
    };
    assert.deepEqual(decodeSessionContinuitySnapshot(retrying), retrying);
    // Snapshots written after #3393 carry the host-clock schedule time so a
    // re-projection can recompute the remaining wait; the field is optional
    // for older snapshots.
    const retryingWithTs = {
      ...continuitySnapshot('epoch-1'),
      rootTurn: {
        ...continuitySnapshot('epoch-1').rootTurn,
        providerRetry: {
          phase: 'scheduled' as const,
          attempt: 8,
          maxAttempts: 10,
          delayMs: 40_000,
          ts: 1_700_000_000_000,
          reason: 'rate_limit' as const,
        },
      },
    };
    assert.deepEqual(decodeSessionContinuitySnapshot(retryingWithTs), retryingWithTs);
    assert.throws(
      () =>
        decodeSessionContinuitySnapshot({
          ...waiting,
          rootTurn: { ...waiting.rootTurn, status: 'waiting_permission' },
        }),
      isInvalidFrame,
    );
    const oversized = {
      ...opened,
      result: {
        ...opened.result,
        activeAssistantStreams: Array.from({ length: 1_000 }, (_, index) => ({
          kind: 'text' as const,
          turnId: 'turn-1',
          messageId: `message-${index}-${'x'.repeat(96)}`,
        })),
      },
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify(oversized.result), 'utf8') >
        SUBSCRIPTION_OPEN_RESULT_MAX_BYTES,
    );
    assert.throws(() => decodeHostFrame(oversized), isInvalidFrame);
  });

  test('normalizes legacy Session statuses in continuity snapshots', () => {
    for (const status of ['review', 'done']) {
      const decoded = decodeSessionContinuitySnapshot({
        ...continuitySnapshot('epoch-1'),
        session: { ...continuitySnapshot('epoch-1').session, status },
      });
      assert.equal(decoded.session.status, 'active');
    }
  });

  test('rejects unknown Session statuses in continuity snapshots', () => {
    assert.throws(
      () =>
        decodeSessionContinuitySnapshot({
          ...continuitySnapshot('epoch-1'),
          session: { ...continuitySnapshot('epoch-1').session, status: 'unknown' },
        }),
      isInvalidSessionStatus,
    );
  });

  test('decodes only privacy-normalized bounded subscription live frames', () => {
    const envelope = {
      kind: 'subscription.session_event' as const,
      hostEpoch: 'epoch-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      sessionId: 'session-1',
      runId: 'run-1',
    };
    const identity = {
      id: 'event-1',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
    };
    for (const event of [
      {
        ...identity,
        type: 'tool_start',
        toolName: 'read',
        displayName: 'Read file',
      },
      {
        ...identity,
        type: 'tool_start',
        toolName: 'Bash',
        intent: '只读探索:定位渲染入口',
        argsPreview: { command: 'git status --porcelain' },
      },
      {
        ...identity,
        type: 'tool_output_delta',
        seq: 0,
        stream: 'stdout',
        chunk: 'visible output',
        redacted: false,
        createdAt: 2,
      },
      { ...identity, type: 'tool_progress', chunk: 'working' },
      { ...identity, type: 'tool_result', status: 'completed', durationMs: 3 },
      {
        ...identity,
        type: 'tool_result',
        status: 'errored',
        sandboxFailureReason: 'sandbox_boundary_required',
      },
      {
        ...identity,
        type: 'tool_result_preview',
        isError: false,
        content: {
          kind: 'subagent',
          childSessionId: 'child-1',
          agentName: 'Local Read',
          turnId: 'turn-child',
          status: 'running',
          permissionMode: 'explore',
        },
      },
    ]) {
      assert.doesNotThrow(() => decodeHostFrame({ ...envelope, event }));
    }
    for (const event of [
      {
        ...identity,
        type: 'tool_start',
        toolName: 'read',
        args: { path: '/private' },
      },
      {
        ...identity,
        type: 'tool_start',
        toolName: 'read',
        argsPreview: { command: 'x'.repeat(9 * 1024) },
      },
      {
        ...identity,
        type: 'tool_start',
        toolName: 'read',
        intent: 42,
      },
      {
        ...identity,
        type: 'tool_result',
        status: 'errored',
        result: { secret: true },
      },
      {
        ...identity,
        type: 'tool_result',
        status: 'errored',
        error: 'raw provider error',
      },
      {
        ...identity,
        type: 'tool_result',
        status: 'errored',
        sandboxFailureReason: 'raw provider error',
      },
      {
        ...identity,
        type: 'tool_result',
        status: 'completed',
        sandboxFailureReason: 'requires_bypass',
      },
      {
        ...identity,
        type: 'tool_result_preview',
        isError: false,
        content: {
          kind: 'subagent',
          childSessionId: 'child-1',
          agentName: 'Local Read',
          turnId: 'turn-child',
          status: 'running',
          permissionMode: 'explore',
          summary: 'bulk is not open-facts',
        },
      },
    ]) {
      assert.throws(() => decodeHostFrame({ ...envelope, event }), isInvalidFrame);
    }

    // The durable steering echo shares the session-event frame without a
    // toolUseId; unknown keys stay rejected.
    const steering = {
      type: 'steering_message' as const,
      id: 'steering-event-1',
      turnId: 'turn-1',
      ts: 7,
      messageId: 'steering-message-1',
      content: { text: 'steer the turn' },
    };
    const decodedSteering = decodeHostFrame({ ...envelope, event: steering });
    assert.ok('kind' in decodedSteering);
    if ('kind' in decodedSteering) {
      assert.equal(decodedSteering.kind, 'subscription.session_event');
      if (decodedSteering.kind === 'subscription.session_event') {
        assert.deepEqual(decodedSteering.event, steering);
      }
    }
    assert.throws(
      () => decodeHostFrame({ ...envelope, event: { ...steering, toolUseId: 'tool-1' } }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...envelope,
          event: { ...steering, content: { text: 'x'.repeat(49 * 1024) } },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          kind: 'subscription.session_delta',
          hostEpoch: 'epoch-1',
          subscriptionId: 'subscription-1',
          sequence: 1,
          sessionId: 'session-1',
          delta: {
            kind: 'thinking',
            turnId: 'turn-1',
            runId: 'run-1',
            messageId: 'message-1',
            text: 'private reasoning',
            signature: 'provider-signature',
          },
        }),
      isInvalidFrame,
    );
    const completion = {
      kind: 'subscription.session_delta' as const,
      hostEpoch: 'epoch-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      sessionId: 'session-1',
      delta: {
        kind: 'thinking' as const,
        turnId: 'turn-1',
        runId: 'run-1',
        messageId: 'message-1',
        startOffset: 7,
        text: '',
        complete: true as const,
      },
    };
    assert.deepEqual(decodeHostFrame(completion), completion);
    const replacement = {
      ...completion,
      delta: {
        kind: completion.delta.kind,
        turnId: completion.delta.turnId,
        runId: completion.delta.runId,
        messageId: completion.delta.messageId,
        startOffset: 0,
        text: 'final',
        reset: true as const,
      },
    };
    assert.deepEqual(decodeHostFrame(replacement), replacement);
    assert.throws(
      () =>
        decodeHostFrame({
          ...replacement,
          delta: { ...replacement.delta, startOffset: 1 },
        }),
      isInvalidFrame,
    );
  });

  test('validates tool activity kinds at the wire boundary', () => {
    const envelope = {
      kind: 'subscription.session_event' as const,
      hostEpoch: 'epoch-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      sessionId: 'session-1',
      runId: 'run-1',
    };
    const start = {
      id: 'event-1',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
      type: 'tool_start' as const,
      toolName: 'maka_computer',
    };
    assert.doesNotThrow(() =>
      decodeHostFrame({ ...envelope, event: { ...start, activityKind: 'computer' } }),
    );
    assert.throws(
      () => decodeHostFrame({ ...envelope, event: { ...start, activityKind: 'desktop' } }),
      isInvalidFrame,
    );
    assert.throws(
      () => decodeHostFrame({ ...envelope, event: { ...start, activityKind: 7 } }),
      isInvalidFrame,
    );
  });

  test('enforces UTF-8 snapshot, live field, and whole-message byte bounds', () => {
    const snapshot = continuitySnapshot('epoch-1');
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES);
    assert.throws(
      () =>
        decodeSessionContinuitySnapshot({
          ...snapshot,
          padding: 'x'.repeat(SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES),
        }),
      isInvalidFrame,
    );
    const frame = {
      kind: 'subscription.session_delta' as const,
      hostEpoch: 'epoch-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      sessionId: 'session-1',
      delta: {
        kind: 'text' as const,
        turnId: 'turn-1',
        runId: 'run-1',
        messageId: 'message-1',
        text: '界'.repeat(Math.floor(SESSION_LIVE_DELTA_MAX_BYTES / 3) + 1),
      },
    };
    assert.throws(() => decodeHostFrame(frame), isInvalidFrame);
    const eventEnvelope = {
      kind: 'subscription.session_event',
      hostEpoch: 'epoch-1',
      subscriptionId: 'subscription-1',
      sequence: 1,
      sessionId: 'session-1',
      runId: 'run-1',
    };
    const eventIdentity = { id: 'event-1', turnId: 'turn-1', ts: 1, toolUseId: 'tool-1' };
    assert.throws(
      () =>
        decodeHostFrame({
          ...eventEnvelope,
          event: {
            ...eventIdentity,
            type: 'tool_start',
            toolName: '界'.repeat(Math.floor(SESSION_TOOL_NAME_MAX_BYTES / 3) + 1),
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...eventEnvelope,
          event: {
            ...eventIdentity,
            type: 'tool_progress',
            chunk: '界'.repeat(Math.floor(SESSION_LIVE_DELTA_MAX_BYTES / 3) + 1),
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...frame,
          privatePadding: 'x'.repeat(RUNTIME_HOST_MAX_MESSAGE_BYTES),
        }),
      isInvalidFrame,
    );
  });

  test('allows larger credential frames only for validated custom request headers', () => {
    const secret = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: 3 }, (_, index) => [`X-${index}`, '"'.repeat(8_192)]),
      ),
    );
    const secretBase64 = Buffer.from(secret, 'utf8').toString('base64');
    const requestHeadersLocator = {
      scope: 'connection',
      connectionId: '00000000-0000-4000-8000-000000000001',
      kind: 'request_headers',
    } as const;
    const apiKeyLocator = { ...requestHeadersLocator, kind: 'api_key' as const };
    const setCredential = RUNTIME_POLICY_OPERATION_SPECS['credential.vault.set'];
    const exportCredentials = HOST_OPERATION_SPECS['configuration.credentials.export'];

    assert.doesNotThrow(() =>
      setCredential.decodeInput({ locator: requestHeadersLocator, expected: null, secret }),
    );
    assert.throws(
      () => setCredential.decodeInput({ locator: apiKeyLocator, expected: null, secret }),
      isInvalidFrame,
    );
    assert.doesNotThrow(() =>
      exportCredentials.decodeOutput({
        credential: { locator: requestHeadersLocator, secretBase64 },
      }),
    );
    assert.doesNotThrow(() =>
      encodeProtocolMessage({
        requestId: 'credential-export',
        operation: 'configuration.credentials.export',
        ok: true,
        result: { credential: { locator: requestHeadersLocator, secretBase64 } },
      }),
    );
    assert.throws(
      () =>
        exportCredentials.decodeOutput({
          credential: { locator: apiKeyLocator, secretBase64 },
        }),
      isInvalidFrame,
    );
  });

  test('keeps the connection update model limit aligned with the catalog', () => {
    const updateConnection = RUNTIME_POLICY_OPERATION_SPECS['connection.catalog.update'];
    const enabledModelIds = Array.from(
      { length: CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS },
      (_, index) => `model-${index}`,
    );
    const input = {
      expected: { connectionId: '00000000-0000-4000-8000-000000000001', revision: 1 },
      changes: {
        name: 'OpenRouter',
        enabled: true,
        enabledModelIds,
      },
    };

    assert.doesNotThrow(() => updateConnection.decodeInput(input));
    assert.throws(
      () =>
        updateConnection.decodeInput({
          ...input,
          changes: {
            ...input.changes,
            enabledModelIds: [...enabledModelIds, 'model-too-many'],
          },
        }),
      isInvalidFrame,
    );
  });

  test('keeps Runtime Policy request and response codecs exact', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'policy-query',
        operation: 'runtime.policy.query',
        input: {},
      }),
      {
        requestId: 'policy-query',
        operation: 'runtime.policy.query',
        input: {},
      },
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'policy-query-extra',
          operation: 'runtime.policy.query',
          input: { secret: 'must-not-cross-wire' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'credential-status-secret',
          operation: 'credential.vault.query',
          ok: true,
          result: {
            kind: 'status',
            status: {
              locator: { scope: 'network_proxy', kind: 'password' },
              configured: false,
              credentialId: null,
              revision: null,
              updatedAt: null,
              secret: 'must-not-cross-wire',
            },
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'undeclared-error',
          operation: 'runtime.policy.query',
          ok: false,
          error: { code: 'commit_outcome_unknown', message: 'not declared for query' },
        }),
      isInvalidFrame,
    );
  });

  test('encodes maximum legal tool output as one bounded frame without identity loss', () => {
    const chunks = [
      ['CJK', '界'.repeat(TOOL_OUTPUT_DELTA_MAX_CHARS)],
      ['NUL', '\0'.repeat(TOOL_OUTPUT_DELTA_MAX_CHARS)],
      ['lone surrogate', '\ud800'.repeat(TOOL_OUTPUT_DELTA_MAX_CHARS)],
    ] as const;
    for (const [label, chunk] of chunks) {
      assert.ok(
        Buffer.byteLength(chunk, 'utf8') <= SESSION_TOOL_OUTPUT_DELTA_MAX_BYTES,
        `${label} exceeds the tool output raw-byte bound`,
      );
      const frame = {
        kind: 'subscription.session_event' as const,
        hostEpoch: 'epoch-1',
        subscriptionId: 'subscription-1',
        sequence: 1,
        sessionId: 'session-1',
        runId: 'run-1',
        event: {
          type: 'tool_output_delta' as const,
          id: `event-${label}`,
          turnId: 'turn-1',
          ts: 1,
          toolUseId: 'tool-1',
          seq: 23,
          stream: 'stdout' as const,
          chunk,
          redacted: false,
          createdAt: 2,
        },
      };

      const encoded = encodeProtocolMessage(frame);
      assert.ok(
        encoded.byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES,
        `${label} envelope exceeds the protocol message limit`,
      );
      const decoded = decodeHostFrame(JSON.parse(encoded.toString('utf8')));
      assert.ok('kind' in decoded);
      if (!('kind' in decoded)) continue;
      assert.equal(decoded.kind, 'subscription.session_event');
      if (decoded.kind !== 'subscription.session_event') continue;
      assert.equal(decoded.event.type, 'tool_output_delta');
      if (decoded.event.type !== 'tool_output_delta') continue;
      assert.equal(decoded.event.id, `event-${label}`);
      assert.equal(decoded.event.seq, 23);
      assert.equal(decoded.event.chunk, chunk);
    }
  });

  test('encodes a legal large sandbox boundary Interaction without disconnecting the client', () => {
    const identity = 'i'.repeat(128);
    const frame = {
      requestId: 'q'.repeat(128),
      operation: 'interaction.query' as const,
      ok: true as const,
      result: {
        schemaVersion: 1 as const,
        interactionId: identity,
        sessionId: identity,
        turnId: identity,
        runId: identity,
        revision: 2 as const,
        request: {
          kind: 'sandbox_boundary' as const,
          expansion: {
            filesystem: {
              entries: Array.from({ length: 32 }, (_, index) => ({
                path: `/opt/service-${index}/${'x'.repeat(1_980)}`,
                access: 'read' as const,
                scope: 'exact' as const,
              })),
            },
          },
          justification: '\u0001'.repeat(2_000),
        },
        status: 'answered' as const,
        outcome: {
          kind: 'sandbox_boundary_decision' as const,
          decision: 'allow' as const,
          status: 'approved' as const,
          committedAt: Number.MAX_SAFE_INTEGER,
        },
      },
    };

    const canonical = decodeHostFrame(frame);
    assert.ok(Buffer.byteLength(`${JSON.stringify(canonical)}\n`, 'utf8') > 64 * 1024);
    const encoded = encodeProtocolMessage(canonical);
    assert.ok(encoded.byteLength <= RUNTIME_HOST_MAX_MESSAGE_BYTES);
    assert.deepEqual(decodeHostFrame(JSON.parse(encoded.toString('utf8'))), canonical);
  });

  test('keeps the operation registry closed at request and response boundaries', () => {
    assert.throws(
      () => decodeClientFrame({ requestId: 'request-1', operation: 'store.read', input: {} }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-2',
          operation: 'turn.query',
          input: { sessionId: 'session-1', turnId: 'turn-1', path: '/tmp/private' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-3',
          operation: 'turn.query',
          ok: false,
          error: { code: 'session_busy', message: 'busy' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-unknown-field',
          operation: 'host.status',
          ok: false,
          error: { code: 'host_draining', message: 'draining' },
          trace: 'private',
        }),
      isInvalidFrame,
    );
  });

  test('keeps safe-boundary continuation plans closed and bounded', () => {
    const query = {
      requestId: 'resume-query-1',
      operation: 'turn.resume.query' as const,
      input: {
        sessionId: 'session-1',
        sourceRunId: 'run-source-1',
        expectedRuntimeEventHighWater: 2,
      },
    };
    assert.deepEqual(decodeClientFrame(query), query);
    assert.throws(
      () =>
        decodeClientFrame({
          ...query,
          input: { sessionId: 'session-1', expectedRuntimeEventHighWater: 2 },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          ...query,
          input: { ...query.input, expectedRuntimeEventHighWater: 0 },
        }),
      isInvalidFrame,
    );

    const ready = {
      requestId: query.requestId,
      operation: query.operation,
      ok: true as const,
      result: {
        sessionId: 'session-1',
        disposition: 'ready' as const,
        sourceRunId: 'run-source-1',
        sourceTurnId: 'turn-source-1',
        sourceRuntimeEventHighWater: 2,
      },
    };
    assert.deepEqual(decodeHostFrame(ready), ready);
    assert.throws(
      () =>
        HOST_OPERATION_SPECS['turn.resume.query'].assertOutputForInput?.(query.input, {
          ...ready.result,
          sourceRuntimeEventHighWater: 3,
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...ready,
          result: { ...ready.result, diagnostics: ['private runtime detail'] },
        }),
      isInvalidFrame,
    );

    const parked = {
      requestId: query.requestId,
      operation: query.operation,
      ok: true as const,
      result: {
        sessionId: 'session-1',
        disposition: 'parked' as const,
        reason: 'safety_check_failed' as const,
      },
    };
    assert.deepEqual(decodeHostFrame(parked), parked);
    for (const reason of [
      'resume_feature_disabled',
      'continuation_authority_unavailable',
      'safety_observation_unavailable',
    ] as const) {
      const unavailable = {
        ...parked,
        result: { ...parked.result, reason },
      };
      assert.deepEqual(decodeHostFrame(unavailable), unavailable);
    }
    assert.throws(
      () =>
        decodeHostFrame({
          ...parked,
          result: { ...parked.result, reason: 'continuation_unavailable' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...parked,
          result: { ...parked.result, reason: 'workspace_identity_mismatch' },
        }),
      isInvalidFrame,
    );

    const start = {
      requestId: 'resume-start-1',
      operation: 'turn.resume.start' as const,
      input: {
        sessionId: 'session-1',
        turnId: 'turn-resume-1',
        sourceRunId: 'run-source-1',
        sourceRuntimeEventHighWater: 2,
      },
    };
    assert.deepEqual(decodeClientFrame(start), start);
    const started = {
      requestId: start.requestId,
      operation: start.operation,
      ok: true as const,
      result: {
        kind: 'started' as const,
        turn: {
          sessionId: 'session-1',
          turnId: 'turn-resume-1',
          runId: 'run-resume-1',
          status: 'running' as const,
        },
      },
    };
    assert.deepEqual(decodeHostFrame(started), started);
    assert.throws(
      () =>
        decodeHostFrame({
          ...started,
          result: { kind: 'parked', plan: ready.result },
        }),
      isInvalidFrame,
    );
  });

  test('requires stable Message command identities, origin Host Epoch, and exact inputs', () => {
    const query = {
      requestId: 'query-request-1',
      operation: 'turn.message.query' as const,
      input: {
        sessionId: 'session-1',
        messageIds: ['message-1', 'message-2', 'message-3'],
      },
    };
    const executionQuery = {
      requestId: 'execution-query-request-1',
      operation: 'turn.message.execution.query' as const,
      input: query.input,
    };
    const submit = {
      requestId: 'submit-request-1',
      operation: 'turn.message.submit' as const,
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        content: { text: 'adjust the active turn' },
        placement: 'current_turn' as const,
      },
    };
    const retract = {
      requestId: 'retract-request-1',
      operation: 'queue.retract' as const,
      input: { originHostEpoch: 'epoch-1', sessionId: 'session-1', retractId: 'retract-1' },
    };
    const interrupt = {
      requestId: 'interrupt-request-1',
      operation: 'turn.interrupt' as const,
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        interruptId: 'interrupt-1',
        turnId: 'turn-1',
        runId: 'run-1',
      },
    };
    assert.deepEqual(decodeClientFrame(query), query);
    assert.deepEqual(decodeClientFrame(executionQuery), executionQuery);
    const queried = {
      requestId: executionQuery.requestId,
      operation: executionQuery.operation,
      ok: true as const,
      result: {
        resolutions: [
          { messageId: 'message-1', state: 'pending' as const },
          {
            messageId: 'message-2',
            state: 'owned' as const,
            turnId: 'turn-2',
            runId: 'run-2',
          },
          { messageId: 'message-3', state: 'cancelled' as const },
        ],
      },
    };
    assert.deepEqual(decodeHostFrame(queried), queried);
    assert.throws(
      () =>
        decodeHostFrame({
          ...queried,
          result: {
            ...queried.result,
            resolutions: [...queried.result.resolutions, ...queried.result.resolutions],
          },
        }),
      isInvalidFrame,
    );
    assert.deepEqual(decodeClientFrame(submit), submit);
    assert.deepEqual(decodeClientFrame(retract), retract);
    assert.deepEqual(decodeClientFrame(interrupt), interrupt);
    const entryRetract = {
      requestId: 'entry-retract-request-1',
      operation: 'queue.entry.retract' as const,
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        entryId: 'entry-1',
        retractId: 'retract-2',
      },
    };
    const entryPromote = {
      requestId: 'entry-promote-request-1',
      operation: 'queue.entry.promote' as const,
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        entryId: 'entry-1',
        promoteId: 'promote-1',
      },
    };
    const entryUpdate = {
      requestId: 'entry-update-request-1',
      operation: 'queue.entry.update' as const,
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        entryId: 'entry-1',
        updateId: 'update-1',
        expectedQueueRevision: 7,
        text: 'updated message',
      },
    };
    const entriesReorder = {
      requestId: 'entries-reorder-request-1',
      operation: 'queue.entries.reorder' as const,
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        reorderId: 'reorder-1',
        entryIds: ['entry-2', 'entry-1'],
      },
    };
    assert.deepEqual(decodeClientFrame(entryRetract), entryRetract);
    assert.deepEqual(decodeClientFrame(entryPromote), entryPromote);
    assert.deepEqual(decodeClientFrame(entryUpdate), entryUpdate);
    assert.deepEqual(decodeClientFrame(entriesReorder), entriesReorder);
    assert.throws(
      () =>
        decodeClientFrame({
          ...entryUpdate,
          input: { ...entryUpdate.input, text: '   ' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          ...entriesReorder,
          input: { ...entriesReorder.input, entryIds: ['entry-1', 'entry-1'] },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          ...entriesReorder,
          input: { ...entriesReorder.input, entryIds: ['not/a/semantic/id'] },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          ...entryRetract,
          input: { ...entryRetract.input, generation: 1 },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          ...entryPromote,
          input: { ...entryPromote.input, entryId: 'not/a/semantic/id' },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({ ...submit, input: { ...submit.input, originHostEpoch: undefined } }),
      isInvalidFrame,
    );
    assert.throws(
      () => decodeClientFrame({ ...retract, input: { ...retract.input, generation: 1 } }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          ...interrupt,
          input: { ...interrupt.input, interruptId: 'not/a/semantic/id' },
        }),
      isInvalidFrame,
    );
  });

  test('decodes old-Epoch ambiguity only for operations that declare outcome_unknown', () => {
    const response = {
      requestId: 'submit-old-epoch',
      operation: 'turn.message.submit' as const,
      ok: false as const,
      error: {
        code: 'outcome_unknown' as const,
        message: 'Message disposition cannot be proven in this Host Epoch',
      },
    };
    assert.deepEqual(decodeHostFrame(response), response);
    assert.throws(() => decodeHostFrame({ ...response, operation: 'turn.query' }), isInvalidFrame);
  });

  test('accepts bounded explicit Skill identities on turn.start', () => {
    const start = (skillIds: unknown, text = '') =>
      decodeClientFrame({
        requestId: 'skill-start',
        operation: 'turn.start',
        input: {
          sessionId: 'session-1',
          turnId: 'turn-skill-1',
          content: { text },
          skillIds,
        },
      });
    assert.deepEqual(start(['writer', 'project:maka:reviewer']), {
      requestId: 'skill-start',
      operation: 'turn.start',
      input: {
        sessionId: 'session-1',
        turnId: 'turn-skill-1',
        content: { text: '' },
        skillIds: ['writer', 'project:maka:reviewer'],
      },
    });
    assert.doesNotThrow(() =>
      start(Array.from({ length: TURN_SKILL_ID_MAX_COUNT }, (_, index) => `skill-${index}`)),
    );
    for (const skillIds of [
      Array.from({ length: TURN_SKILL_ID_MAX_COUNT + 1 }, (_, index) => `skill-${index}`),
      ['bad/id'],
      ['bad id'],
      ['x'.repeat(TURN_SKILL_ID_MAX_LENGTH + 1)],
      [1],
    ]) {
      assert.throws(() => start(skillIds), isInvalidFrame);
    }
    assert.deepEqual(start(undefined, 'plain'), {
      requestId: 'skill-start',
      operation: 'turn.start',
      input: {
        sessionId: 'session-1',
        turnId: 'turn-skill-1',
        content: { text: 'plain' },
      },
    });
    assert.deepEqual(start([], 'plain'), {
      requestId: 'skill-start',
      operation: 'turn.start',
      input: {
        sessionId: 'session-1',
        turnId: 'turn-skill-1',
        content: { text: 'plain' },
      },
    });
  });

  test('bounds turn.start feedback as one transport-safe result', () => {
    const receipt = {
      invocation: 'explicit' as const,
      request: 'writer',
      success: true as const,
      ref: 'workspace:legacy:writer',
      id: 'writer',
      name: 'Writer',
      scope: 'workspace' as const,
      source: 'legacy' as const,
      truncated: false,
    };
    const response = {
      requestId: 'skill-start-response',
      operation: 'turn.start' as const,
      ok: true as const,
      result: {
        kind: 'started' as const,
        turn: {
          sessionId: 'session-1',
          turnId: 'turn-skill-1',
          runId: 'run-skill-1',
          status: 'running' as const,
        },
        skillInvocation: {
          loaded: [{ id: receipt.id, name: receipt.name }],
          failed: [],
          receipts: [receipt],
        },
      },
    };
    assert.deepEqual(decodeHostFrame(response), response);
    assert.ok(encodeProtocolMessage(response).byteLength < RUNTIME_HOST_MAX_MESSAGE_BYTES);

    const request = 'r'.repeat(TURN_SKILL_ID_MAX_LENGTH);
    const id = 'i'.repeat(81);
    const name = '"'.repeat(256);
    const oversized = {
      ...response,
      result: {
        ...response.result,
        skillInvocation: {
          loaded: Array.from({ length: TURN_SKILL_ID_MAX_COUNT }, () => ({ id, name })),
          failed: [],
          receipts: Array.from({ length: TURN_SKILL_ID_MAX_COUNT }, () => ({
            ...receipt,
            request,
            ref: `workspace:legacy:${id}`,
            id,
            name,
          })),
        },
      },
    };
    assert.throws(() => decodeHostFrame(oversized), isInvalidFrame);
  });

  test('decodes a closed regenerate identity without accepting replacement content', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request-regenerate',
        operation: 'turn.regenerate',
        input: {
          sessionId: 'session-1',
          sourceTurnId: 'turn-source',
          turnId: 'turn-regenerated',
        },
      }),
      {
        requestId: 'request-regenerate',
        operation: 'turn.regenerate',
        input: {
          sessionId: 'session-1',
          sourceTurnId: 'turn-source',
          turnId: 'turn-regenerated',
        },
      },
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request-regenerate',
          operation: 'turn.regenerate',
          input: {
            sessionId: 'session-1',
            sourceTurnId: 'turn-source',
            turnId: 'turn-regenerated',
            content: { text: 'replacement' },
          },
        }),
      isInvalidFrame,
    );
  });

  test('bounds canonical MessageContent attachments and quotes', () => {
    const submit = (content: unknown) =>
      decodeClientFrame({
        requestId: 'submit-bounds',
        operation: 'turn.message.submit',
        input: {
          originHostEpoch: 'epoch-1',
          sessionId: 'session-1',
          messageId: 'message-1',
          content,
          placement: 'next_turn',
        },
      });
    assert.doesNotThrow(() =>
      submit({
        text: 'valid',
        attachments: Array.from({ length: MAX_ATTACHMENT_COUNT }, (_, index) =>
          attachmentRef({ kind: 'workspace_file', relativePath: `${index}.ts` }),
        ),
      }),
    );
    const contextContent = {
      text: 'valid context ref',
      attachments: [
        attachmentRef({
          kind: 'session_context' as const,
          sessionId: 'session-1',
          refId: 'read-image:owner-1',
        }),
      ],
    };
    assert.throws(() => submit(contextContent), isInvalidFrame);
    assert.deepEqual(decodeMessageContent(contextContent), contextContent);
    assert.throws(
      () =>
        submit({
          text: 'valid',
          attachments: Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, (_, index) =>
            attachmentRef({ kind: 'workspace_file', relativePath: `${index}.ts` }),
          ),
        }),
      isInvalidFrame,
    );
    for (const attachment of [
      { ...attachmentRef({ kind: 'workspace_file', relativePath: 'a.ts' }), bytes: -1 },
      {
        ...attachmentRef({ kind: 'workspace_file', relativePath: 'a.ts' }),
        bytes: MAX_ATTACHMENT_BYTES + 1,
      },
      { ...attachmentRef({ kind: 'workspace_file', relativePath: 'a.ts' }), name: '' },
      { ...attachmentRef({ kind: 'workspace_file', relativePath: 'a.ts' }), mimeType: '' },
      attachmentRef({ kind: 'workspace_file', relativePath: 'a'.repeat(4097) }),
      attachmentRef({ kind: 'session_file', sessionId: 'bad/id', relativePath: 'a.ts' }),
      attachmentRef({ kind: 'session_context', sessionId: 'session-1', refId: '' }),
      attachmentRef({ kind: 'session_context', sessionId: 'session-1', refId: 'a'.repeat(513) }),
      attachmentRef({ kind: 'workspace_file', relativePath: '../secret' }),
      attachmentRef({ kind: 'workspace_file', relativePath: 'src//a.ts' }),
      attachmentRef({ kind: 'external_file', absolutePath: 'relative/a.ts' }),
    ]) {
      assert.throws(() => submit({ text: 'valid', attachments: [attachment] }), isInvalidFrame);
    }
    assert.doesNotThrow(() =>
      submit({
        text: 'valid',
        quotes: Array.from({ length: TURN_MESSAGE_QUOTE_MAX_COUNT }, (_, index) => ({
          text: `excerpt-${index}`,
          label: 'Assistant',
          sourceTurnId: `turn-${index}`,
        })),
      }),
    );
    for (const quotes of [
      Array.from({ length: TURN_MESSAGE_QUOTE_MAX_COUNT + 1 }, () => ({ text: 'excerpt' })),
      [{ text: '' }],
      [{ text: 'x'.repeat(TURN_MESSAGE_QUOTE_TEXT_MAX_LENGTH + 1) }],
      [{ text: 'excerpt', label: '' }],
      [{ text: 'excerpt', label: 'x'.repeat(TURN_MESSAGE_QUOTE_LABEL_MAX_LENGTH + 1) }],
      [{ text: 'excerpt', sourceTurnId: 'bad/id' }],
      [{ text: 'excerpt', sourceTurnId: 'x'.repeat(129) }],
      [{ text: 'excerpt', extra: true }],
    ]) {
      assert.throws(() => submit({ text: 'valid', quotes }), isInvalidFrame);
    }
    assert.throws(
      () => submit({ text: 'a'.repeat(TURN_MESSAGE_CONTENT_MAX_BYTES), displayText: 'also large' }),
      isInvalidFrame,
    );
  });

  test('bounds Message text in UTF-8 bytes while preserving frame headroom', () => {
    const input = {
      originHostEpoch: 'epoch-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      content: { text: 'a'.repeat(TURN_MESSAGE_TEXT_MAX_BYTES) },
      placement: 'next_turn' as const,
    };
    const frame = decodeClientFrame({
      requestId: 'submit-request-1',
      operation: 'turn.message.submit',
      input,
    });
    assert.ok(encodeProtocolMessage(frame).byteLength < RUNTIME_HOST_MAX_MESSAGE_BYTES);
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'submit-request-2',
          operation: 'turn.message.submit',
          input: {
            ...input,
            content: { text: '界'.repeat(Math.floor(TURN_MESSAGE_TEXT_MAX_BYTES / 3) + 1) },
          },
        }),
      isInvalidFrame,
    );
  });

  test('decodes exact submit dispositions and bounded retract and interrupt results', () => {
    for (const result of [
      { disposition: 'steering', queueRevision: 2 },
      { disposition: 'followup', queueRevision: 3 },
      { disposition: 'turn_started', turnId: 'turn-2' },
    ]) {
      assert.doesNotThrow(() =>
        decodeHostFrame({
          requestId: 'submit-response',
          operation: 'turn.message.submit',
          ok: true,
          result,
        }),
      );
    }
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'submit-response',
          operation: 'turn.message.submit',
          ok: true,
          result: { disposition: 'turn_started', turnId: 'turn-2', queueRevision: 4 },
        }),
      isInvalidFrame,
    );
    for (const [operation, requestId] of [
      ['queue.entry.retract', 'entry-retract-response'],
      ['queue.entry.promote', 'entry-promote-response'],
      ['queue.entry.update', 'entry-update-response'],
      ['queue.entries.reorder', 'entries-reorder-response'],
    ] as const) {
      assert.doesNotThrow(() =>
        decodeHostFrame({
          requestId,
          operation,
          ok: true,
          result: { queueRevision: 8 },
        }),
      );
      assert.throws(
        () =>
          decodeHostFrame({
            requestId,
            operation,
            ok: true,
            result: { queueRevision: 8, retracted: [] },
          }),
        isInvalidFrame,
      );
    }
    const retracted = [retractedMessage()];
    assert.doesNotThrow(() =>
      decodeHostFrame({
        requestId: 'interrupt-response',
        operation: 'turn.interrupt',
        ok: true,
        result: {
          queueRevision: 5,
          retracted,
          turn: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            runId: 'run-1',
            status: 'cancelled',
            terminalEventId: 'event-1',
            abortSource: 'user_interrupt',
          },
        },
      }),
    );
    const oversized = Array.from({ length: MESSAGE_QUEUE_MAX_ENTRIES }, (_, index) => ({
      ...retractedMessage('a'.repeat(900)),
      entryId: `entry-${index}`,
      messageId: `message-${index}`,
    }));
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > MESSAGE_OPERATION_RESULT_MAX_BYTES);
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'retract-response',
          operation: 'queue.retract',
          ok: true,
          result: { queueRevision: 6, retracted: oversized },
        }),
      isInvalidFrame,
    );
  });

  test('validates queued, in-flight, and retracted snapshots as closed bounded unions', () => {
    const projectedQuotes = [
      { text: 'one', sourceTurnId: 'turn-1' },
      { text: 'two', label: 'User', sourceTurnId: 'turn-2' },
    ];
    const followup = {
      ...queuedMessage('later', 'next_turn'),
      entryId: 'entry-3',
      messageId: 'm-3',
      content: { text: 'later', quotes: projectedQuotes },
    };
    const projectionWire = {
      hostEpoch: 'epoch-1',
      queueRevision: 7,
      steering: [queuedMessage(), inFlightMessage()],
      followup: [followup],
    };
    assert.deepEqual(
      decodeSessionMessageQueueProjection(JSON.parse(JSON.stringify(projectionWire))),
      projectionWire,
    );
    for (const projection of [
      {
        hostEpoch: 'epoch-1',
        queueRevision: 1,
        steering: [queuedMessage('wrong lane', 'next_turn')],
        followup: [],
      },
      {
        hostEpoch: 'epoch-1',
        queueRevision: 1,
        steering: [],
        followup: [{ ...inFlightMessage(), placement: 'next_turn' }],
      },
      {
        hostEpoch: 'epoch-1',
        queueRevision: 1,
        steering: [],
        followup: [queuedMessage('wrong followup lane', 'current_turn')],
      },
      {
        hostEpoch: 'epoch-1',
        queueRevision: 1,
        steering: [queuedMessage(), { ...queuedMessage(), entryId: 'other-entry' }],
        followup: [],
      },
      {
        hostEpoch: 'epoch-1',
        queueRevision: 1,
        steering: Array.from({ length: MESSAGE_QUEUE_MAX_ENTRIES + 1 }, (_, index) => ({
          ...queuedMessage(),
          entryId: `entry-${index}`,
          messageId: `message-${index}`,
        })),
        followup: [],
      },
    ]) {
      assert.throws(() => decodeSessionMessageQueueProjection(projection), isInvalidFrame);
    }
  });

  test('rejects duplicate operation keys while composing domain registries', () => {
    const composeUnchecked = composeOperationSpecMaps as (
      left: typeof HOST_BOOTSTRAP_OPERATION_SPECS,
      right: typeof HOST_BOOTSTRAP_OPERATION_SPECS,
    ) => unknown;
    assert.throws(
      () => composeUnchecked(HOST_BOOTSTRAP_OPERATION_SPECS, HOST_BOOTSTRAP_OPERATION_SPECS),
      /Duplicate Runtime Host operation key: host\.status/,
    );
  });

  test('keeps Runtime Host logs within the diagnostics operation contract', () => {
    for (let index = 0; index < 257; index += 1) {
      runtimeHostLogBuffer.append('info', `entry ${index}`);
    }
    runtimeHostLogBuffer.append('error', '🚀'.repeat(3_000));
    const entryBoundedLogs = runtimeHostLogBuffer.snapshot();

    assert.equal(entryBoundedLogs.length, 256);

    for (let index = 0; index < 256; index += 1) {
      runtimeHostLogBuffer.append('info', `retained detail ${index} ${'x'.repeat(256)}`);
    }
    const logs = runtimeHostLogBuffer.snapshot();
    const encodedLogBytes = Buffer.byteLength(JSON.stringify(logs));

    assert.ok(encodedLogBytes > 48 * 1024);
    assert.ok(encodedLogBytes <= RUNTIME_HOST_DIAGNOSTIC_LOG_MAX_BYTES);
    assert.doesNotThrow(() =>
      HOST_BOOTSTRAP_OPERATION_SPECS['host.diagnostics.query'].decodeOutput({
        hostEpoch: 'epoch-1',
        compositionId: 'maka.interactive',
        compositionRevision: '1',
        compositionModules: ['interactive'],
        residencies: [{ label: 'hosted-execution', count: 1 }],
        state: 'ready',
        connections: 1,
        activeOperations: 0,
        activeResidencies: 0,
        protocolVersion: 0,
        compatibilityEpoch: 9,
        pid: 42,
        processUptimeSeconds: 1,
        nodeVersion: '22.0.0',
        platform: 'linux',
        arch: 'x64',
        osRelease: '6.6.0',
        logs,
      }),
    );
  });

  test('rejects terminal snapshots with fields from another terminal variant', () => {
    assert.throws(
      () =>
        decodeHostFrame({
          requestId: 'request-4',
          operation: 'turn.query',
          ok: true,
          result: {
            sessionId: 'session-1',
            turnId: 'turn-1',
            runId: 'run-1',
            status: 'completed',
            terminalEventId: 'event-1',
            abortSource: 'user',
          },
        }),
      isInvalidFrame,
    );
  });

  test('carries a bounded failed Turn message without opening the snapshot shape', () => {
    const response = {
      requestId: 'request-failed-turn',
      operation: 'turn.query' as const,
      ok: true as const,
      result: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        runId: 'run-1',
        status: 'failed' as const,
        terminalEventId: 'event-1',
        failureClass: 'unknown',
        failureMessage: 'Provider request failed',
      },
    };

    assert.deepEqual(decodeHostFrame(response), response);
    for (const contextBudgetExhaustedDetail of CONTEXT_BUDGET_EXHAUSTED_DETAILS) {
      const withContextDetail = {
        ...response,
        result: {
          ...response.result,
          failureClass: 'context_budget_exhausted',
          contextBudgetExhaustedDetail,
        },
      };
      assert.deepEqual(decodeHostFrame(withContextDetail), withContextDetail);
    }
    assert.throws(
      () =>
        decodeHostFrame({
          ...response,
          result: {
            ...response.result,
            contextBudgetExhaustedDetail: 'unknown_detail',
          },
        }),
      isInvalidFrame,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          ...response,
          result: {
            ...response.result,
            failureMessage: '界'.repeat(TURN_FAILURE_MESSAGE_MAX_BYTES),
          },
        }),
      isInvalidFrame,
    );
  });

  test('bounds encoded protocol messages', () => {
    const empty = {
      kind: 'draining',
      hostEpoch: '',
      compositionId: 'maka.interactive',
      compositionRevision: '1',
    } as const;
    const overhead = Buffer.byteLength(JSON.stringify(empty), 'utf8');
    const value = {
      ...empty,
      hostEpoch: 'x'.repeat(RUNTIME_HOST_MAX_MESSAGE_BYTES - overhead),
    };
    const message = encodeProtocolMessage(value);

    assert.equal(message.byteLength, RUNTIME_HOST_MAX_MESSAGE_BYTES);
    assert.notEqual(message.at(-1), 0x0a);
    assert.throws(
      () => encodeProtocolMessage({ ...value, hostEpoch: `${value.hostEpoch}x` }),
      (error: unknown) =>
        error instanceof RuntimeHostProtocolError && error.code === 'frame_too_large',
    );
  });
});

test('Client Capability tool descriptors preserve only known activity kinds', () => {
  const input = {
    registrationId: 'registration-1',
    offers: [
      {
        offerId: 'desktop_computer_use',
        version: '0',
        affinity: 'session',
        hostPathAccess: 'cwd',
        label: 'Computer Use',
        tools: [
          {
            serverId: 'desktop_computer_use',
            name: 'maka_computer',
            inputSchema: { type: 'object' },
            activityKind: 'computer',
          },
        ],
      },
    ],
  };

  assert.equal(
    decodeClientCapabilityReplaceInput(input).offers[0]?.tools[0]?.activityKind,
    'computer',
  );
  assert.throws(
    () =>
      decodeClientCapabilityReplaceInput({
        ...input,
        offers: [
          {
            ...input.offers[0],
            tools: [{ ...input.offers[0]!.tools[0], activityKind: 'desktop' }],
          },
        ],
      }),
    isInvalidFrame,
  );
});

test('Client Capability progress frames require bounded monotonic coordinates', () => {
  assert.deepEqual(
    decodeClientFrame({
      kind: 'client.capability.progress',
      invocationId: 'invocation-1',
      current: 7,
      total: 11,
    }),
    {
      kind: 'client.capability.progress',
      invocationId: 'invocation-1',
      current: 7,
      total: 11,
    },
  );
  assert.throws(
    () =>
      decodeClientFrame({
        kind: 'client.capability.progress',
        invocationId: 'invocation-1',
        current: 12,
        total: 11,
      }),
    isInvalidFrame,
  );
  assert.throws(
    () =>
      decodeClientFrame({
        kind: 'client.capability.progress',
        invocationId: 'invocation-1',
        current: 1,
        total: 1_025,
      }),
    isInvalidFrame,
  );
});

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
}

function isInvalidSessionStatus(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.message === 'Invalid Session status';
}

function queuedMessage(
  text = 'adjust this turn',
  placement: 'current_turn' | 'next_turn' = 'current_turn',
) {
  return {
    entryId: 'entry-1',
    messageId: 'message-1',
    content: { text },
    placement,
    state: 'queued' as const,
  };
}

function inFlightMessage() {
  return {
    ...queuedMessage('already pulled'),
    entryId: 'entry-2',
    messageId: 'message-2',
    state: 'in_flight' as const,
  };
}

function retractedMessage(text = 'do this next') {
  return {
    entryId: 'entry-retracted',
    messageId: 'message-retracted',
    content: { text },
    placement: 'next_turn' as const,
    state: 'retracted' as const,
  };
}

function attachmentRef(
  ref:
    | { kind: 'session_file'; sessionId: string; relativePath: string }
    | { kind: 'session_context'; sessionId: string; refId: string }
    | { kind: 'workspace_file'; relativePath: string }
    | { kind: 'external_file'; absolutePath: string },
) {
  return { kind: 'code' as const, name: 'a.ts', mimeType: 'text/typescript', bytes: 10, ref };
}

function continuitySnapshot(hostEpoch: string) {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running' as const,
      createdAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running' as const,
    },
    goal: null,
    queue: {
      hostEpoch,
      queueRevision: 1,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
  };
}
