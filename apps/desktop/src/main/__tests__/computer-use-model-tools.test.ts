import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MakaTool } from '@maka/runtime';
import { computerUseToolsForModel } from '../computer-use-model-tools.js';

const tool = (name: string): MakaTool => ({ name } as MakaTool);

describe('Computer Use model tool visibility', () => {
  const computer = tool('maka_computer');
  const shell = tool('Bash');

  it('removes screenshot-returning Computer Use tools for text-only models', () => {
    assert.deepEqual(
      computerUseToolsForModel([shell, computer], [computer], false).map((candidate) => candidate.name),
      ['Bash'],
    );
  });

  it('preserves the complete tool surface for visual models', () => {
    assert.deepEqual(
      computerUseToolsForModel([shell, computer], [computer], true).map((candidate) => candidate.name),
      ['Bash', 'maka_computer'],
    );
  });
});
