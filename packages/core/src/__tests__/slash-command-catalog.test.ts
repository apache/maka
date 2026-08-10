import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SLASH_COMMAND_CATALOG, slashCommandsForSurface } from '../slash-command-catalog.js';

describe('slash command catalog', () => {
  it('owns every built-in command identity and alias once', () => {
    const identities = SLASH_COMMAND_CATALOG.flatMap((command) => [
      command.id,
      ...('aliases' in command ? command.aliases : []),
    ]);
    assert.equal(new Set(identities).size, identities.length);
    const exit = SLASH_COMMAND_CATALOG.find(({ id }) => id === 'exit');
    assert.ok(exit && 'aliases' in exit);
    assert.deepEqual(exit.aliases, ['quit']);
  });

  it('declares the commands each product surface can actually execute', () => {
    assert.ok(SLASH_COMMAND_CATALOG.every(({ surfaces }) => surfaces.length > 0));
    assert.deepEqual(
      slashCommandsForSurface('desktop').map(({ id }) => id),
      ['compact', 'graph', 'side', 'swarm'],
    );
    assert.deepEqual(
      slashCommandsForSurface('tui').map(({ id }) => id),
      [
        'compact',
        'context',
        'exit',
        'graph',
        'help',
        'model',
        'move',
        'new',
        'permissions',
        'recap',
        'rename',
        'resume',
        'rewind',
        'session',
        'setup',
        'skill',
        'swarm',
        'thinking',
      ],
    );
  });
});
