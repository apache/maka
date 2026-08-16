import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveEffectiveOrchestration } from '../orchestration.js';

describe('orchestration contract', () => {
  test('a persisted swarm mode grants only the session-scoped swarm authorization', () => {
    assert.deepEqual(resolveEffectiveOrchestration('swarm', undefined), {
      mode: 'swarm',
      source: 'session',
      agentSwarmAuthorization: 'session_mode',
    });
  });

  test('graph mode preserves the graph identity without granting swarm authority', () => {
    assert.deepEqual(resolveEffectiveOrchestration('graph', undefined), {
      mode: 'graph',
      source: 'session',
      agentSwarmAuthorization: 'none',
    });
  });

  test('a trusted turn override wins without changing the persisted session mode', () => {
    assert.deepEqual(
      resolveEffectiveOrchestration('default', { mode: 'swarm', source: 'host_api' }),
      {
        mode: 'swarm',
        source: 'turn_override',
        agentSwarmAuthorization: 'turn_override',
      },
    );
    assert.deepEqual(
      resolveEffectiveOrchestration('swarm', { mode: 'default', source: 'slash_command' }),
      {
        mode: 'default',
        source: 'turn_override',
        agentSwarmAuthorization: 'none',
      },
    );
  });
});
