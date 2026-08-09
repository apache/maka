import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SLASH_COMMAND_CATALOG,
  slashCommandsForSurface,
  slashCommandSpec,
} from '../slash-command-catalog.js';

describe('slash command catalog', () => {
  it('owns every built-in command identity and alias once', () => {
    assert.deepEqual(
      SLASH_COMMAND_CATALOG.map(({ id }) => id),
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
        'side',
        'skill',
        'swarm',
        'thinking',
      ],
    );
    assert.deepEqual(slashCommandSpec('exit'), {
      id: 'exit',
      aliases: ['quit'],
      tail: 'none',
      session: 'none',
      surfaces: ['tui'],
    });
  });

  it('describes the shared tail grammar used by every surface', () => {
    assert.equal(slashCommandSpec('compact').tail, 'none');
    assert.equal(slashCommandSpec('rename').tail, 'required');
    assert.equal(slashCommandSpec('side').tail, 'optional');
    assert.equal(slashCommandSpec('skill').tail, 'none');
    assert.equal(slashCommandSpec('swarm').tail, 'optional');
  });

  it('declares the commands each product surface can actually execute', () => {
    assert.deepEqual(
      slashCommandsForSurface('desktop').map(({ id }) => id),
      ['compact', 'graph', 'side', 'swarm'],
    );
    assert.deepEqual(
      slashCommandsForSurface('tui').map(({ id }) => id),
      SLASH_COMMAND_CATALOG.filter(({ id }) => id !== 'side').map(({ id }) => id),
    );
  });
});
