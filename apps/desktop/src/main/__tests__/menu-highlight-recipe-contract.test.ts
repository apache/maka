import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

const MENU_PRIMITIVE = join(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'menu.tsx');

describe('menu highlight authority', () => {
  it('delegates menu state colors to Astryx instead of maintaining a local recipe', async () => {
    const source = await readFile(MENU_PRIMITIVE, 'utf8');

    assert.match(source, /from '@astryxdesign\/core\/DropdownMenu'/);
    assert.doesNotMatch(source, /data-highlighted:|data-popup-open:|text-destructive-/);
    assert.doesNotMatch(source, /@base-ui\/react\/menu/);
  });
});
