import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_ID } from '@maka/runtime/scheduled-task-tools';
import {
  CLIENT_CAPABILITY_MAX_MANIFEST_BYTES,
  CLIENT_CAPABILITY_MAX_OFFERS,
  CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES,
  decodeClientCapabilityResult,
  decodeClientFrame,
  decodeHostFrame,
  RuntimeHostProtocolError,
} from '../protocol/index.js';

describe('Client Capability protocol', () => {
  test('decodes open-world registration and reverse-call lifecycle frames', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request',
        operation: 'client.capability.replace',
        input: {
          registrationId: 'registration',
          offers: [
            {
              offerId: 'not_known_by_host',
              version: 'vendor-v3',
              affinity: 'call',
              hostPathAccess: 'none',
              label: 'Vendor-defined capability',
              tools: [
                {
                  serverId: 'not_known_by_host',
                  name: 'vendor_action',
                  description: 'A tool absent from Host source.',
                  inputSchema: {
                    type: 'object',
                    properties: { value: { type: 'string' } },
                  },
                },
              ],
            },
          ],
        },
      }),
      {
        requestId: 'request',
        operation: 'client.capability.replace',
        input: {
          registrationId: 'registration',
          offers: [
            {
              offerId: 'not_known_by_host',
              version: 'vendor-v3',
              affinity: 'call',
              hostPathAccess: 'none',
              label: 'Vendor-defined capability',
              tools: [
                {
                  serverId: 'not_known_by_host',
                  name: 'vendor_action',
                  description: 'A tool absent from Host source.',
                  inputSchema: {
                    type: 'object',
                    properties: { value: { type: 'string' } },
                  },
                },
              ],
            },
          ],
        },
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        kind: 'client.capability.call',
        invocationId: 'invocation',
        registrationId: 'registration',
        offerId: 'not_known_by_host',
        serverId: 'not_known_by_host',
        toolName: 'vendor_action',
        arguments: { value: 'hello' },
        sessionId: 'session',
        turnId: 'turn',
        toolCallId: 'tool-call',
      }),
      {
        kind: 'client.capability.call',
        invocationId: 'invocation',
        registrationId: 'registration',
        offerId: 'not_known_by_host',
        serverId: 'not_known_by_host',
        toolName: 'vendor_action',
        arguments: { value: 'hello' },
        sessionId: 'session',
        turnId: 'turn',
        toolCallId: 'tool-call',
      },
    );
    assert.deepEqual(
      decodeClientFrame({
        kind: 'client.capability.accepted',
        invocationId: 'invocation',
      }),
      {
        kind: 'client.capability.accepted',
        invocationId: 'invocation',
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        kind: 'client.capability.admitted',
        invocationId: 'invocation',
      }),
      {
        kind: 'client.capability.admitted',
        invocationId: 'invocation',
      },
    );
  });

  test('keeps Host services open-world and outside model tool offers', () => {
    assert.deepEqual(
      decodeClientFrame({
        requestId: 'request',
        operation: 'client.capability.replace',
        input: {
          registrationId: 'registration',
          offers: [],
          services: [{ serviceId: SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_ID, version: 'vendor-v4' }],
        },
      }),
      {
        requestId: 'request',
        operation: 'client.capability.replace',
        input: {
          registrationId: 'registration',
          offers: [],
          services: [{ serviceId: SCHEDULED_TASK_NATIVE_EFFECT_SERVICE_ID, version: 'vendor-v4' }],
        },
      },
    );
    assert.deepEqual(
      decodeHostFrame({
        kind: 'client.capability.service_call',
        invocationId: 'invocation',
        registrationId: 'registration',
        serviceId: 'vendor_service',
        version: 'vendor-v4',
        method: 'present',
        input: { value: 'hello' },
      }),
      {
        kind: 'client.capability.service_call',
        invocationId: 'invocation',
        registrationId: 'registration',
        serviceId: 'vendor_service',
        version: 'vendor-v4',
        method: 'present',
        input: { value: 'hello' },
      },
    );
    assert.throws(
      () =>
        decodeClientFrame({
          requestId: 'request',
          operation: 'client.capability.replace',
          input: {
            registrationId: 'registration',
            offers: [],
            services: [
              { serviceId: 'same_service', version: '1' },
              { serviceId: 'same_service', version: '1' },
            ],
          },
        }),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );
  });

  test('rejects empty, duplicate, recursive, and over-budget provider data', () => {
    assert.throws(
      () => decodeClientFrame(replaceFrame([])),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame(
          replaceFrame(
            Array.from({ length: CLIENT_CAPABILITY_MAX_OFFERS + 1 }, (_, index) =>
              offer(`offer_${index}`, `tool_${index}`),
            ),
          ),
        ),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame(
          replaceFrame([
            {
              ...offer('oversized_manifest', 'tool'),
              tools: Array.from({ length: 3 }, (_, index) => ({
                serverId: 'oversized_manifest',
                name: `tool_${index}`,
                inputSchema: {
                  type: 'object',
                  description: 'x'.repeat(Math.ceil(CLIENT_CAPABILITY_MAX_MANIFEST_BYTES / 3)),
                },
              })),
            },
          ]),
        ),
      (error: unknown) =>
        error instanceof RuntimeHostProtocolError && error.code === 'invalid_frame',
    );
    assert.throws(
      () => decodeClientFrame(replaceFrame([offer('same', 'tool'), offer('same', 'other')])),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );
    const recursive: Record<string, unknown> = { type: 'object' };
    recursive.self = recursive;
    assert.throws(
      () =>
        decodeClientFrame(
          replaceFrame([
            {
              ...offer('recursive', 'tool'),
              tools: [
                {
                  ...offer('recursive', 'tool').tools[0],
                  inputSchema: recursive,
                },
              ],
            },
          ]),
        ),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );
    for (const inputSchema of [
      { type: 'string' },
      { type: 'object', unsupportedKeyword: true },
      { type: 'object', properties: { value: { $ref: 'https://example.test/schema' } } },
      { type: 'object', properties: { value: { $ref: '#/$defs/missing' } } },
    ]) {
      assert.throws(
        () =>
          decodeClientFrame(
            replaceFrame([
              {
                ...offer('invalid_schema', 'tool'),
                tools: [
                  {
                    ...offer('invalid_schema', 'tool').tools[0],
                    inputSchema,
                  },
                ],
              },
            ]),
          ),
        (error: unknown) => error instanceof RuntimeHostProtocolError,
      );
    }
    assert.doesNotThrow(() =>
      decodeClientFrame(
        replaceFrame([
          {
            ...offer('local_schema', 'tool'),
            tools: [
              {
                ...offer('local_schema', 'tool').tools[0],
                inputSchema: {
                  type: 'object',
                  properties: { value: { $ref: '#/$defs/value' } },
                  $defs: {
                    value: {
                      anyOf: [{ type: 'string', maxLength: 128 }, { type: 'null' }],
                    },
                  },
                },
              },
            ],
          },
        ]),
      ),
    );
    assert.doesNotThrow(() =>
      decodeClientFrame(
        replaceFrame([
          {
            ...offer('tuple_schema', 'move'),
            tools: [
              {
                ...offer('tuple_schema', 'move').tools[0],
                inputSchema: {
                  type: 'object',
                  properties: {
                    coordinate: {
                      type: 'array',
                      items: [{ type: 'integer' }, { type: 'integer' }],
                    },
                  },
                },
              },
            ],
          },
        ]),
      ),
    );
    for (const items of [[], [{ type: 'integer' }, 'not-a-schema']]) {
      assert.throws(
        () =>
          decodeClientFrame(
            replaceFrame([
              {
                ...offer('invalid_tuple_schema', 'move'),
                tools: [
                  {
                    ...offer('invalid_tuple_schema', 'move').tools[0],
                    inputSchema: {
                      type: 'object',
                      properties: { coordinate: { type: 'array', items } },
                    },
                  },
                ],
              },
            ]),
          ),
        (error: unknown) => error instanceof RuntimeHostProtocolError,
      );
    }
    assert.throws(
      () =>
        decodeClientFrame({
          kind: 'client.capability.result_start',
          invocationId: 'invocation',
          byteLength: CLIENT_CAPABILITY_RESULT_CHUNK_MAX_BYTES + 1,
          chunkCount: 1,
        }),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );
    assert.throws(
      () =>
        decodeHostFrame({
          kind: 'client.capability.call',
          invocationId: 'invocation',
          registrationId: 'registration',
          offerId: 'offer',
          serverId: 'offer',
          toolName: 'tool',
          arguments: { value: 'x'.repeat(41 * 1024) },
          sessionId: 'session',
          turnId: 'turn',
          toolCallId: 'tool-call',
          cwd: '/workspace',
        }),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );
  });

  test('requires explicit affinity and Host path access', () => {
    const missingAffinity = offer('fixture', 'inspect') as Record<string, unknown>;
    delete missingAffinity.affinity;
    assert.throws(
      () => decodeClientFrame(replaceFrame([missingAffinity])),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );
    const missingHostPathAccess = offer('fixture', 'inspect') as Record<string, unknown>;
    delete missingHostPathAccess.hostPathAccess;
    assert.throws(
      () => decodeClientFrame(replaceFrame([missingHostPathAccess])),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );
    assert.throws(
      () =>
        decodeClientFrame(
          replaceFrame([
            {
              ...offer('fixture', 'inspect'),
              affinity: 'process',
            },
          ]),
        ),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );

    const poisonedSchema = JSON.parse('{"__proto__":{"type":"object"}}') as Record<string, unknown>;
    assert.throws(
      () =>
        decodeClientFrame(
          replaceFrame([
            {
              ...offer('fixture', 'inspect'),
              tools: [
                {
                  serverId: 'fixture',
                  name: 'inspect',
                  inputSchema: poisonedSchema,
                },
              ],
            },
          ]),
        ),
      (error: unknown) => error instanceof RuntimeHostProtocolError,
    );
  });

  test('rejects non-canonical media data and invalid image MIME types', () => {
    assert.deepEqual(
      decodeClientCapabilityResult({
        content: [
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          { type: 'audio', data: 'YQ==', mimeType: 'audio/wav' },
          { type: 'resource', uri: 'file:///result.bin', blob: 'AQI=' },
        ],
      }),
      {
        content: [
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
          { type: 'audio', data: 'YQ==', mimeType: 'audio/wav' },
          { type: 'resource', uri: 'file:///result.bin', blob: 'AQI=' },
        ],
      },
    );

    for (const content of [
      [{ type: 'image', data: 'aGVsbG8', mimeType: 'image/png' }],
      [{ type: 'audio', data: '!!!!', mimeType: 'audio/wav' }],
      [{ type: 'resource', uri: 'file:///result.bin', blob: 'AQI' }],
      [{ type: 'image', data: 'YQ==', mimeType: 'text/plain' }],
      [{ type: 'image', data: 'YQ==', mimeType: 'image/' }],
      [{ type: 'image', data: 'YQ==', mimeType: 'image/png; charset=binary' }],
    ]) {
      assert.throws(
        () => decodeClientCapabilityResult({ content }),
        (error: unknown) => error instanceof RuntimeHostProtocolError,
      );
    }
  });
});

function replaceFrame(offers: unknown[]) {
  return {
    requestId: 'request',
    operation: 'client.capability.replace',
    input: { registrationId: 'registration', offers },
  };
}

function offer(offerId: string, toolName: string) {
  return {
    offerId,
    version: '0',
    affinity: 'call',
    hostPathAccess: 'cwd',
    label: offerId,
    tools: [
      {
        serverId: offerId,
        name: toolName,
        inputSchema: { type: 'object' },
      },
    ],
  };
}
