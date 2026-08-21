import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGraphCommand } from '../graph-command.js';

test('parses Graph lifecycle controls without consuming ordinary one-shot tasks', () => {
  assert.deepEqual(parseGraphCommand('/graph'), { kind: 'status' });
  assert.deepEqual(parseGraphCommand('/graph history'), { kind: 'history' });
  assert.deepEqual(parseGraphCommand('/graph on'), { kind: 'set_mode', mode: 'graph' });
  assert.deepEqual(parseGraphCommand('/graph investigate history'), {
    kind: 'run_once',
    task: 'investigate history',
  });
  assert.equal(parseGraphCommand('/graphical history'), null);
});
