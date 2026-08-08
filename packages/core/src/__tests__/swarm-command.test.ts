import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseSwarmCommand } from '../swarm-command.js';

describe('/swarm parser', () => {
  test('parses explicit mode changes', () => {
    assert.deepEqual(parseSwarmCommand('/swarm on'), { kind: 'set_mode', mode: 'swarm' });
    assert.deepEqual(parseSwarmCommand('/swarm off'), { kind: 'set_mode', mode: 'default' });
  });

  test('does not claim lookalike slash commands', () => {
    assert.equal(parseSwarmCommand('/swarming now'), null);
  });
});
