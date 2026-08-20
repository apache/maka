import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import { decodeClientFrame, decodeHostFrame } from '../protocol/index.js';

test('network proxy detection uses a closed credential-free projection', () => {
  assert.deepEqual(
    decodeClientFrame({
      requestId: 'request',
      operation: 'network-proxy.detect',
      input: {},
    }),
    {
      requestId: 'request',
      operation: 'network-proxy.detect',
      input: {},
    },
  );
  assert.deepEqual(
    decodeHostFrame({
      requestId: 'request',
      operation: 'network-proxy.detect',
      ok: true,
      result: {
        candidate: {
          source: 'environment',
          proxy: {
            enabled: true,
            type: 'http',
            host: '127.0.0.1',
            port: 7897,
            bypassList: ['localhost'],
          },
          requiresAuthentication: false,
        },
      },
    }),
    {
      requestId: 'request',
      operation: 'network-proxy.detect',
      ok: true,
      result: {
        candidate: {
          source: 'environment',
          proxy: {
            enabled: true,
            type: 'http',
            host: '127.0.0.1',
            port: 7897,
            bypassList: ['localhost'],
          },
          requiresAuthentication: false,
        },
      },
    },
  );
  assert.throws(
    () =>
      decodeHostFrame({
        requestId: 'request',
        operation: 'network-proxy.detect',
        ok: true,
        result: {
          candidate: {
            source: 'environment',
            proxy: {
              enabled: true,
              type: 'http',
              host: '127.0.0.1',
              port: 7897,
              username: 'must-not-cross-the-boundary',
              password: 'must-not-cross-the-boundary',
              bypassList: [],
            },
            requiresAuthentication: true,
          },
        },
      }),
    (error: unknown) => error instanceof RuntimeHostProtocolError,
  );
});
