import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseCssBlocks, readAllRendererCss } from './css-test-helpers.js';

describe('composer focus ownership CSS contract', () => {
  it('keeps Astryx composer internals outside product CSS', async () => {
    const blocks = parseCssBlocks(await readAllRendererCss());
    const internalRules = blocks
      .map((block) => block.rule)
      .filter((selector) => /\.maka-composer-editor(?:\s*[>+~]|\s+)/.test(selector));

    assert.deepEqual(
      internalRules,
      [],
      'Maka CSS may position the ChatComposerInput root but must not style its Astryx-owned descendants',
    );
  });
});
