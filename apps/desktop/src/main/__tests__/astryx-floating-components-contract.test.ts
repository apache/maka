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

  it('makes Astryx DropdownMenu the only menu behavior authority', async () => {
    const source = await readUiSource('primitives/menu.tsx');
    assert.match(source, /from '@astryxdesign\/core\/DropdownMenu'/);
    assert.doesNotMatch(source, /@base-ui\/react\/menu/);

    const consumerPaths = [
      'chat-model-switcher.tsx',
      'composer-workspace-row.tsx',
      'composer.tsx',
      'module-hub-selector.tsx',
      'plan-reminder-form-dialog.tsx',
      'plan-reminder-panel.tsx',
      'session-history-list.tsx',
      'session-list-panel.tsx',
    ];
    const consumers = (
      await Promise.all(consumerPaths.map((path) => readUiSource(path)))
    ).join('\n');
    assert.doesNotMatch(consumers, /<Menu(?:Trigger|Popup|Sub)/);
  });
  it('makes Astryx Dialog the only modal behavior authority', async () => {
    const [source, header, toast] = await Promise.all([
      readUiSource('ui.tsx'),
      readUiSource('primitives/dialog-header.tsx'),
      readUiSource('toast.tsx'),
    ]);

    assert.match(source, /from '@astryxdesign\/core\/Dialog'/);
    assert.match(header, /DialogHeader as AstryxDialogHeader[\s\S]*from '@astryxdesign\/core\/Dialog'/);
    assert.doesNotMatch(source, /@base-ui\/react\/(?:alert-)?dialog/);
    assert.doesNotMatch(header, /@base-ui\/react\/(?:alert-)?dialog|buttonVariants|<button\b/);
    assert.match(toast, /AlertDialog as AstryxAlertDialog[\s\S]*from '@astryxdesign\/core\/AlertDialog'/);
  });

  it('uses one Astryx LayerProvider and Astryx toast lifecycle', async () => {
    const source = await readUiSource('toast.tsx');

    assert.match(source, /LayerProvider[\s\S]*from '@astryxdesign\/core\/Layer'/);
    assert.match(source, /useToast as useAstryxToast[\s\S]*from '@astryxdesign\/core\/Toast'/);
    assert.match(source, /<LayerProvider toast=\{\{ position: 'bottomEnd' \}\}>/);
    assert.doesNotMatch(source, /@base-ui\/react\/toast|createToastManager|BaseToast/);
  });
});
