import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const TABS_FILE = resolve(REPO_ROOT, 'packages/ui/src/primitives/tabs.tsx');

describe('tabs design-system boundary', () => {
  it('delegates tab presentation and navigation to Astryx without a local skin', async () => {
    const source = await readFile(TABS_FILE, 'utf8');

    assert.match(source, /from '@astryxdesign\/core\/TabList'/);
    assert.match(source, /<AstryxTabList/);
    assert.match(source, /hasDivider=\{hasDivider \?\? variant === 'underline'\}/);
    assert.doesNotMatch(source, /@base-ui\/react\/tabs|TabsPrimitive\.Indicator/);
    assert.doesNotMatch(source, /className=\{cn\(|transition-\[|rounded-|bg-/);
  });
});
