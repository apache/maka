import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseGraphCommand } from '../graph-command.js';

describe('/graph parser', () => {
  test('parses bare and explicit status commands', () => {
    assert.deepEqual(parseGraphCommand('/graph'), { kind: 'status' });
    assert.deepEqual(parseGraphCommand('  /graph status  '), { kind: 'status' });
  });

  test('parses persistent mode changes only when the whole tail matches', () => {
    assert.deepEqual(parseGraphCommand('/graph on'), { kind: 'set_mode', mode: 'graph' });
    assert.deepEqual(parseGraphCommand('/graph off'), { kind: 'set_mode', mode: 'default' });
    assert.deepEqual(parseGraphCommand('/graph on the repository'), {
      kind: 'run_once',
      task: 'on the repository',
    });
  });

  test('preserves a one-shot task as clean user text', () => {
    assert.deepEqual(parseGraphCommand('/graph inspect runtime, UI, and tests'), {
      kind: 'run_once',
      task: 'inspect runtime, UI, and tests',
    });
  });

  test('does not claim lookalike slash commands', () => {
    assert.equal(parseGraphCommand('/graphing now'), null);
    assert.equal(parseGraphCommand('please /graph this'), null);
  });
});
