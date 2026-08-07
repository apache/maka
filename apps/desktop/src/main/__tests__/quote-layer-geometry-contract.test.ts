import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import postcss from 'postcss';
import { readRendererContractCss } from './contract-css-helpers.js';

describe('quote layer geometry', () => {
  it('keeps the positioning transform stable during entry', async () => {
    const root = postcss.parse(await readRendererContractCss());
    const entry = root.nodes.find(
      (node) => node.type === 'atrule' && node.name === 'keyframes' && node.params === 'maka-quote-actions-in',
    );

    assert.ok(entry && entry.type === 'atrule', 'the quote layer has an entry animation');
    assert.equal(
      entry.nodes?.some(
        (node) => node.type === 'rule' && node.nodes.some((child) => child.type === 'decl' && child.prop === 'transform'),
      ),
      false,
      'the entry animation must not override the transform used to position the layer',
    );
  });
});
