import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertCreateAgentGraphInstanceRequest,
  decodeAgentGraphInstance,
  isAgentGraphInstance,
} from '../agent-graph-instance.js';

describe('Agent Graph instance contract', () => {
  test('decodes open and finished instances with strict lifecycle invariants', () => {
    assert.deepEqual(
      decodeAgentGraphInstance({
        schemaVersion: 1,
        graphId: 'graph-1',
        rootSessionId: 'root-1',
        sequence: 1,
        status: 'open',
        createdAt: 10,
      }),
      {
        schemaVersion: 1,
        graphId: 'graph-1',
        rootSessionId: 'root-1',
        sequence: 1,
        status: 'open',
        createdAt: 10,
      },
    );
    assert.equal(
      isAgentGraphInstance({
        schemaVersion: 1,
        graphId: 'graph-1',
        rootSessionId: 'root-1',
        sequence: 1,
        status: 'finished',
        createdAt: 10,
        finishedAt: 11,
      }),
      true,
    );
    assert.equal(
      isAgentGraphInstance({
        schemaVersion: 1,
        graphId: 'graph-1',
        rootSessionId: 'root-1',
        sequence: 1,
        status: 'open',
        createdAt: 10,
        finishedAt: 11,
      }),
      false,
    );
  });

  test('accepts only exact create requests', () => {
    assert.doesNotThrow(() =>
      assertCreateAgentGraphInstanceRequest({
        schemaVersion: 1,
        graphId: 'graph-1',
        rootSessionId: 'root-1',
      }),
    );
    assert.throws(() =>
      assertCreateAgentGraphInstanceRequest({
        schemaVersion: 1,
        graphId: 'graph-1',
        rootSessionId: 'root-1',
        extra: true,
      }),
    );
  });
});
