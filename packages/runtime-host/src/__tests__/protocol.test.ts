import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from '@maka/core/attachments';
import { TOOL_OUTPUT_DELTA_MAX_CHARS } from '@maka/core/events';
import {
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
  RUNTIME_HOST_MAX_MESSAGE_BYTES,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
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
  RuntimeHostProtocolError,
} from '../protocol/index.js';
import { HOST_BOOTSTRAP_OPERATION_SPECS } from '../protocol/host-status.js';
import { composeOperationSpecMaps } from '../protocol/operation-spec.js';
import { runtimeHostLogBuffer } from '../process-diagnostics.js';
import {
  TURN_MESSAGE_QUOTE_LABEL_MAX_LENGTH,
  TURN_MESSAGE_QUOTE_MAX_COUNT,
  TURN_MESSAGE_QUOTE_TEXT_MAX_LENGTH,
  TURN_FAILURE_MESSAGE_MAX_BYTES,
  TURN_SKILL_ID_MAX_COUNT,
  TURN_SKILL_ID_MAX_LENGTH,
} from '../protocol/turn.js';

describe('Runtime Host bootstrap protocol', () => {
  test('selects the highest mutually supported protocol and rejects a gap', () => {
    assert.equal(negotiateProtocol({ min: 0, max: 0 }, { min: 0, max: 0 }), 0);
    assert.equal(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 4 }), 3);
    assert.equal(negotiateProtocol({ min: 0, max: 0 }, { min: 1, max: 1 }), undefined);
    assert.throws(() => negotiateProtocol({ min: -1, max: 0 }, { min: 0, max: 0 }), isInvalidFrame);
  });

  test('keeps the subscription queue Epoch correlated', () => {
    assert.equal(SESSION_CONTINUITY_SCHEMA_VERSION, 3);
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
    assert.deepEqual(decodeClientFrame(submit), submit);
    assert.deepEqual(decodeClientFrame(retract), retract);
    assert.deepEqual(decodeClientFrame(interrupt), interrupt);
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
    const logs = runtimeHostLogBuffer.snapshot();

    assert.equal(logs.length, 256);
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

function isInvalidFrame(error: unknown): boolean {
  return error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame';
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
      lastUsedAt: 2,
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
