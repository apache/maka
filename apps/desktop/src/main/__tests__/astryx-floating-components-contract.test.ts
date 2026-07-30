import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

const UI_ROOT = join(REPO_ROOT, 'packages', 'ui', 'src');

async function readUiSource(path: string): Promise<string> {
  return readFile(join(UI_ROOT, path), 'utf8');
}

describe('#1565 PR 6 Astryx floating-component authority', () => {
  it('makes Astryx Selector the only implementation authority for settings selects', async () => {
    const source = await readUiSource('primitives/settings-select.tsx');

    assert.match(source, /from '@astryxdesign\/core\/Selector'/);
    assert.doesNotMatch(source, /SelectRoot|SelectTrigger|SelectPopup|SelectItem/);
  });

  it('drives the searchable model picker through Astryx combobox and popover hooks', async () => {
    const source = await readUiSource('model-picker.tsx');

    assert.match(source, /useCombobox[\s\S]*from '@astryxdesign\/core\/Selector'/);
    assert.match(source, /usePopover[\s\S]*from '@astryxdesign\/core\/Popover'/);
    assert.doesNotMatch(source, /@base-ui\/react\/combobox|BaseCombobox/);
  });
});
