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
  encodeProtocolFrame,
  HOST_OPERATION_SPECS,
  MESSAGE_OPERATION_RESULT_MAX_BYTES,
  MESSAGE_QUEUE_MAX_ENTRIES,
  negotiateProtocol,
  ProtocolFrameDecoder,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RUNTIME_HOST_PROTOCOL_VERSION,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  SESSION_CONTINUITY_SNAPSHOT_MAX_BYTES,
  SESSION_LIVE_DELTA_MAX_BYTES,
  SESSION_TOOL_OUTPUT_DELTA_MAX_BYTES,
  SESSION_TOOL_NAME_MAX_BYTES,
  TURN_MESSAGE_CONTENT_MAX_BYTES,
  TURN_MESSAGE_TEXT_MAX_BYTES,
  RUNTIME_POLICY_OPERATION_SPECS,
  RuntimeHostProtocolError,
} from '../protocol/index.js';
import { HOST_STATUS_OPERATION_SPECS } from '../protocol/host-status.js';
import { composeOperationSpecMaps } from '../protocol/operation-spec.js';
import {
  TURN_MESSAGE_QUOTE_LABEL_MAX_LENGTH,
  TURN_MESSAGE_QUOTE_MAX_COUNT,
  TURN_MESSAGE_QUOTE_TEXT_MAX_LENGTH,
} from '../protocol/turn.js';

describe('Runtime Host bootstrap protocol', () => {
  test('selects the highest mutually supported protocol and rejects a gap', () => {
    assert.equal(negotiateProtocol({ min: 0, max: 0 }, { min: 0, max: 0 }), 0);
    assert.equal(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 4 }), 3);
    assert.equal(negotiateProtocol({ min: 0, max: 0 }, { min: 1, max: 1 }), undefined);
    assert.throws(() => negotiateProtocol({ min: -1, max: 0 }, { min: 0, max: 0 }), isInvalidFrame);
  });

  test('keeps the experimental protocol at v0 with the declared authority operations', () => {
    assert.equal(RUNTIME_HOST_PROTOCOL_VERSION, 0);
    assert.deepEqual(Object.keys(HOST_OPERATION_SPECS).sort(), [
      'artifact.delete',
      'artifact.query',
      'automation.mutate',
      'automation.query',
      'client.capability.replace',
      'client.capability.unregister',
      'connection.catalog.create',
      'connection.catalog.query',
      'connection.catalog.remove',
      'connection.catalog.set-default-target',
      'connection.catalog.update',
      'connection.models.fetch',
      'connection.test.run',
      'credential.vault.delete',
      'credential.vault.query',
      'credential.vault.set',
      'host.status',
      'interaction.answer',
      'interaction.query',
      'memory.mutate',
      'memory.query',
      'pricing.mutate',
      'pricing.query',
      'queue.retract',
      'runtime.policy.mutate',
      'runtime.policy.query',
      'runtime.resource.controller.acquire',
      'runtime.resource.controller.control',
      'runtime.resource.controller.release',
      'runtime.resource.query',
      'runtime.resource.stop',
      'session.branch.create',
      'session.catalog.query',
      'session.configuration.update',
      'session.create',
      'session.metadata.update',
      'session.read_marker.set',
      'session.revision.create',
      'skill.catalog.mutate',
      'skill.catalog.preview-update',
      'skill.catalog.query',
      'subscription.close',
      'subscription.open',
      'task.ledger.query',
      'turn.interrupt',
      'turn.message.submit',
      'turn.query',
      'turn.start',
      'turn.stop',
      'usage.query',
    ]);
    const errors = [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'session_busy',
      'operation_conflict',
      'outcome_unknown',
      'internal_failure',
    ];
    assert.deepEqual(
      Object.fromEntries(
        (['turn.message.submit', 'queue.retract', 'turn.interrupt'] as const).map((operation) => [
          operation,
          {
            mode: HOST_OPERATION_SPECS[operation].mode,
            availability: HOST_OPERATION_SPECS[operation].availability,
            errors: HOST_OPERATION_SPECS[operation].errors,
          },
        ]),
      ),
      {
        'turn.message.submit': { mode: 'command', availability: 'ready', errors },
        'queue.retract': { mode: 'command', availability: 'ready', errors },
        'turn.interrupt': { mode: 'control', availability: 'ready', errors },
      },
    );
  });

  test('keeps subscription operations closed, ready-only, and queue Epoch correlated', () => {
    assert.equal(SESSION_CONTINUITY_SCHEMA_VERSION, 2);
    assert.deepEqual(
      Object.fromEntries(
        (['subscription.open', 'subscription.close'] as const).map((operation) => [
          operation,
          {
            mode: HOST_OPERATION_SPECS[operation].mode,
            availability: HOST_OPERATION_SPECS[operation].availability,
            errors: HOST_OPERATION_SPECS[operation].errors,
          },
        ]),
      ),
      {
        'subscription.open': {
          mode: 'control',
          availability: 'ready',
          errors: [
            'host_not_ready',
            'host_draining',
            'operation_unavailable',
            'not_found',
            'operation_conflict',
            'internal_failure',
          ],
        },
        'subscription.close': {
          mode: 'control',
          availability: 'ready',
          errors: [
            'host_not_ready',
            'host_draining',
            'operation_unavailable',
            'not_found',
            'internal_failure',
          ],
        },
      },
    );
    const opened = {
      requestId: 'open-1',
      operation: 'subscription.open',
      ok: true,
      result: {
        hostEpoch: 'epoch-1',
        subscriptionId: 'subscription-1',
        nextSequence: 1,
        snapshot: continuitySnapshot('epoch-1'),
      },
    };
    assert.deepEqual(decodeHostFrame(opened), opened);
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
  });

  test('enforces UTF-8 snapshot, live field, and whole-frame byte bounds', () => {
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
          privatePadding: 'x'.repeat(RUNTIME_HOST_MAX_FRAME_BYTES),
        }),
      isInvalidFrame,
    );
  });

  test('declares exactly the ten Runtime Policy operations in the current framework', () => {
    const queries = [
      'runtime.policy.query',
      'connection.catalog.query',
      'credential.vault.query',
    ] as const;
    const mutations = [
      'runtime.policy.mutate',
      'connection.catalog.create',
      'connection.catalog.update',
      'connection.catalog.remove',
      'connection.catalog.set-default-target',
      'credential.vault.set',
      'credential.vault.delete',
    ] as const;
    assert.deepEqual(
      Object.keys(RUNTIME_POLICY_OPERATION_SPECS).sort(),
      [...queries, ...mutations].sort(),
    );
    for (const operation of queries) {
      assert.equal(RUNTIME_POLICY_OPERATION_SPECS[operation].mode, 'query');
      assert.equal(RUNTIME_POLICY_OPERATION_SPECS[operation].availability, 'ready');
      assert.ok(RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('persistence_failed'));
      assert.ok(RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('internal_failure'));
    }
    for (const operation of mutations) {
      assert.equal(RUNTIME_POLICY_OPERATION_SPECS[operation].mode, 'command');
      assert.equal(RUNTIME_POLICY_OPERATION_SPECS[operation].availability, 'ready');
      assert.ok(RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('invalid_request'));
      assert.ok(RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('persistence_failed'));
      assert.ok(
        RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('commit_outcome_unknown'),
      );
      assert.ok(RUNTIME_POLICY_OPERATION_SPECS[operation].errors.includes('internal_failure'));
    }
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

      const encoded = encodeProtocolFrame(frame);
      assert.ok(
        encoded.byteLength <= RUNTIME_HOST_MAX_FRAME_BYTES,
        `${label} envelope exceeds the protocol frame limit`,
      );
      const decodedFrames = new ProtocolFrameDecoder().push(encoded);
      assert.equal(decodedFrames.length, 1);
      const decoded = decodeHostFrame(decodedFrames[0]);
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

  test('decodes split UTF-8 and multiple newline-delimited frames without an unbounded tail', () => {
    const decoder = new ProtocolFrameDecoder();
    const wire = Buffer.from(
      `${JSON.stringify({ kind: 'hello', clientInstanceId: '客户端', surface: 'tui', protocolMin: RUNTIME_HOST_PROTOCOL_VERSION, protocolMax: RUNTIME_HOST_PROTOCOL_VERSION })}\n` +
        `${JSON.stringify({ requestId: 'status-1', operation: 'host.status', input: {} })}\n`,
    );
    const split = wire.indexOf(Buffer.from('端')) + 1;
    assert.deepEqual(decoder.push(wire.subarray(0, split)), []);
    const frames = decoder.push(wire.subarray(split));
    assert.equal(frames.length, 2);
    assert.deepEqual(decodeClientFrame(frames[0]), {
      kind: 'hello',
      clientInstanceId: '客户端',
      surface: 'tui',
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
    });
    assert.deepEqual(decodeClientFrame(frames[1]), {
      requestId: 'status-1',
      operation: 'host.status',
      input: {},
    });
    decoder.end();
  });

  test('accepts protocol v0 in handshakes and Host registration while rejecting negatives', () => {
    const accepted = {
      kind: 'accepted' as const,
      hostEpoch: 'epoch-1',
      connectionId: 'connection-1',
      selectedProtocol: RUNTIME_HOST_PROTOCOL_VERSION,
      state: 'ready' as const,
    };
    assert.deepEqual(decodeHostFrame(accepted), accepted);

    const registration = {
      kind: 'maka-runtime-host' as const,
      schemaVersion: 1 as const,
      rootId: 'a'.repeat(64),
      hostEpoch: 'epoch-1',
      endpoint: '/tmp/maka-runtime-host.sock',
      protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
      protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
      state: 'ready' as const,
      pid: 42,
      createdAt: '2026-07-23T00:00:00.000Z',
    };
    assert.deepEqual(decodeHostRegistration(registration), registration);
    assert.throws(
      () =>
        decodeClientFrame({
          kind: 'hello',
          clientInstanceId: 'client-1',
          surface: 'tui',
          protocolMin: -1,
          protocolMax: 0,
        }),
      isInvalidFrame,
    );
    assert.throws(() => decodeHostFrame({ ...accepted, selectedProtocol: -1 }), isInvalidFrame);
    assert.throws(
      () => decodeHostRegistration({ ...registration, protocolMin: -1 }),
      isInvalidFrame,
    );
    assert.throws(
      () => decodeHostRegistration({ ...registration, protocolMax: Number.MAX_SAFE_INTEGER + 1 }),
      isInvalidFrame,
    );
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

  test('uses canonical MessageContent for turn start and submit', () => {
    const attachment = attachmentRef({ kind: 'workspace_file', relativePath: 'src/a.ts' });
    const quotes = [
      { text: 'first excerpt', label: 'Assistant', sourceTurnId: 'turn-source-1' },
      { text: 'second excerpt', sourceTurnId: 'turn-source-2' },
    ];
    const startWire = {
      requestId: 'start-request-1',
      operation: 'turn.start' as const,
      input: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        content: {
          text: 'model text',
          displayText: 'model text',
          attachments: [attachment],
          quotes,
        },
      },
    };
    const start = decodeClientFrame(JSON.parse(encodeProtocolFrame(startWire).toString('utf8')));
    assert.deepEqual(start, {
      requestId: 'start-request-1',
      operation: 'turn.start',
      input: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        content: { text: 'model text', attachments: [attachment], quotes },
      },
    });
    assert.notEqual(start.input.content.quotes, quotes);
    assert.notEqual(start.input.content.quotes?.[0], quotes[0]);
    const submitWire = {
      requestId: 'submit-request-1',
      operation: 'turn.message.submit' as const,
      input: {
        originHostEpoch: 'epoch-1',
        sessionId: 'session-1',
        messageId: 'message-1',
        content: { text: 'follow up', quotes: [...quotes].reverse() },
        placement: 'next_turn' as const,
      },
    };
    assert.deepEqual(
      decodeClientFrame(JSON.parse(encodeProtocolFrame(submitWire).toString('utf8'))),
      submitWire,
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'legacy-start',
          operation: 'turn.start',
          input: { sessionId: 'session-1', turnId: 'turn-1', text: 'legacy' },
        }),
      isInvalidFrame,
    );
    assert.deepEqual(
      decodeClientFrame({
        ...submitWire,
        input: { ...submitWire.input, content: { text: 'valid', quotes: [] } },
      }),
      {
        ...submitWire,
        input: { ...submitWire.input, content: { text: 'valid' } },
      },
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
    assert.ok(encodeProtocolFrame(frame).byteLength < RUNTIME_HOST_MAX_FRAME_BYTES);
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
      left: typeof HOST_STATUS_OPERATION_SPECS,
      right: typeof HOST_STATUS_OPERATION_SPECS,
    ) => unknown;
    assert.throws(
      () => composeUnchecked(HOST_STATUS_OPERATION_SPECS, HOST_STATUS_OPERATION_SPECS),
      /Duplicate Runtime Host operation key: host\.status/,
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

  test('rejects a frame before buffering more than the byte cap', () => {
    const decoder = new ProtocolFrameDecoder();
    assert.throws(
      () => decoder.push(Buffer.alloc(RUNTIME_HOST_MAX_FRAME_BYTES + 1, 0x61)),
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
    queue: {
      hostEpoch,
      queueRevision: 1,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
  };
}
