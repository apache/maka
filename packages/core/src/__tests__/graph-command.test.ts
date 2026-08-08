import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseGraphCommand } from '../graph-command.js';

describe('/graph parser', () => {
  test('parses persistent mode changes', () => {
    assert.deepEqual(parseGraphCommand('/graph on'), { kind: 'set_mode', mode: 'graph' });
    assert.deepEqual(parseGraphCommand('/graph off'), { kind: 'set_mode', mode: 'default' });
  });

  test('does not claim lookalike slash commands', () => {
    assert.equal(parseGraphCommand('/graphing now'), null);
  });
});
