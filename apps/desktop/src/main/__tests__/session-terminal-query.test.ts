import assert from 'node:assert/strict';
import test from 'node:test';
import type { IDisposable, IParser } from '@xterm/xterm';
import {
  isColorQuery,
  isDeviceAttributesQuery,
  isDeviceStatusQuery,
  isPrivateDeviceStatusQuery,
  isWindowReportQuery,
  suppressTerminalQueryReplies,
} from '../../renderer/session-terminal-query.js';

test('recognizes foreground, background, cursor, and indexed color queries', () => {
  assert.equal(isColorQuery(10, '?'), true);
  assert.equal(isColorQuery(11, '?'), true);
  assert.equal(isColorQuery(12, '?'), true);
  assert.equal(isColorQuery(10, '?;?;?'), true);
  assert.equal(isColorQuery(4, '0;?'), true);
  assert.equal(isColorQuery(4, '0;?;15;?'), true);
});

test('does not suppress OSC color setters or mixed set/query operations', () => {
  assert.equal(isColorQuery(10, 'rgb:0f0f/0f0f/1212'), false);
  assert.equal(isColorQuery(11, '#ffffff'), false);
  assert.equal(isColorQuery(4, '0;rgb:0000/0000/0000'), false);
  assert.equal(isColorQuery(4, '0;?;1;#ffffff'), false);
  assert.equal(isColorQuery(4, ''), false);
  assert.equal(isColorQuery(3, '?'), false);
});

test('recognizes device attribute and status report queries', () => {
  assert.equal(isDeviceAttributesQuery([0]), true);
  assert.equal(isDeviceAttributesQuery([1]), false);
  assert.equal(isDeviceStatusQuery([5]), true);
  assert.equal(isDeviceStatusQuery([6]), true);
  assert.equal(isDeviceStatusQuery([6, 1]), false);
  assert.equal(isPrivateDeviceStatusQuery([6]), true);
  assert.equal(isPrivateDeviceStatusQuery([5]), false);
  assert.equal(isPrivateDeviceStatusQuery([[6]]), false);
});

test('recognizes window report queries without intercepting window commands', () => {
  for (const operation of [11, 13, 14, 15, 16, 18, 19, 20, 21]) {
    assert.equal(isWindowReportQuery([operation]), true);
  }
  assert.equal(isWindowReportQuery([8, 24, 80]), false);
  assert.equal(isWindowReportQuery([22, 0]), false);
  assert.equal(isWindowReportQuery([[14]]), false);
});

test('registers and disposes every xterm response-generating query handler', () => {
  const registered: Array<{ kind: string; id: unknown; callback: unknown }> = [];
  let disposed = 0;
  const disposable = (): IDisposable => ({
    dispose: () => {
      disposed += 1;
    },
  });
  const parser = {
    registerOscHandler: (id: number, callback: unknown) => {
      registered.push({ kind: 'osc', id, callback });
      return disposable();
    },
    registerCsiHandler: (id: unknown, callback: unknown) => {
      registered.push({ kind: 'csi', id, callback });
      return disposable();
    },
    registerDcsHandler: (id: unknown, callback: unknown) => {
      registered.push({ kind: 'dcs', id, callback });
      return disposable();
    },
  } as unknown as IParser;

  const queryReplies = suppressTerminalQueryReplies(parser);

  assert.equal(registered.length, 12);
  assert.deepEqual(
    registered.filter(({ kind }) => kind === 'osc').map(({ id }) => id),
    [4, 10, 11, 12],
  );
  assert.equal(
    registered.some(
      ({ kind, id }) =>
        kind === 'dcs' &&
        JSON.stringify(id) === JSON.stringify({ intermediates: '$', final: 'q' }),
    ),
    true,
  );
  queryReplies.dispose();
  assert.equal(disposed, registered.length);
});
