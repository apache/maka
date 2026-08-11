import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseDelegateCommand } from '../delegate-command.js';

describe('/delegate parser', () => {
  test('parses status, persistent mode changes, and one-turn work', () => {
    assert.deepEqual(parseDelegateCommand('/delegate'), { kind: 'status' });
    assert.deepEqual(parseDelegateCommand('/delegate status'), { kind: 'status' });
    assert.deepEqual(parseDelegateCommand('/delegate on'), {
      kind: 'set_mode',
      mode: 'delegate',
    });
    assert.deepEqual(parseDelegateCommand('/delegate off'), {
      kind: 'set_mode',
      mode: 'default',
    });
    assert.deepEqual(parseDelegateCommand('/delegate investigate the regression'), {
      kind: 'run_once',
      task: 'investigate the regression',
    });
  });

  test('does not claim lookalike slash commands', () => {
    assert.equal(parseDelegateCommand('/delegated work'), null);
  });
});
