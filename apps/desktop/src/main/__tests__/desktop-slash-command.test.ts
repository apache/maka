import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDesktopSlashCommand } from '../../renderer/desktop-slash-command.js';

describe('Desktop slash command parsing', () => {
  it('recognizes only input accepted by a Desktop command parser', () => {
    assert.deepEqual(parseDesktopSlashCommand(' /compact '), { kind: 'compact' });
    assert.equal(parseDesktopSlashCommand('/compact explain'), null);
    assert.deepEqual(parseDesktopSlashCommand('/side discuss separately'), {
      kind: 'side',
      command: { prompt: 'discuss separately' },
    });
    assert.deepEqual(parseDesktopSlashCommand('/graph status'), {
      kind: 'graph',
      command: { kind: 'status' },
    });
    assert.deepEqual(parseDesktopSlashCommand('/swarm investigate'), {
      kind: 'swarm',
      command: { kind: 'run_once', task: 'investigate' },
    });
    assert.equal(parseDesktopSlashCommand('explain /side'), null);
  });
});
