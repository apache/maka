import { strict as assert } from 'node:assert';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

const UI_ROOT = join(REPO_ROOT, 'packages', 'ui', 'src');

async function readUiSource(path: string): Promise<string> {
  return readFile(join(UI_ROOT, path), 'utf8');
}

describe('#1565 PR 6 Astryx floating-component authority', () => {
  it('exports Astryx Selector directly instead of preserving a Maka settings-select adapter', async () => {
    const source = await readUiSource('index.ts');

    assert.match(source, /\bSelector,[\s\S]*from '@astryxdesign\/core'/);
    assert.doesNotMatch(source, /settings-select/);
  });

  it('drives the searchable model picker through Astryx combobox and popover hooks', async () => {
    const source = await readUiSource('model-picker.tsx');

    assert.match(source, /useCombobox[\s\S]*from '@astryxdesign\/core\/Selector'/);
    assert.match(source, /usePopover[\s\S]*from '@astryxdesign\/core\/Popover'/);
    assert.doesNotMatch(source, /@base-ui\/react\/combobox|BaseCombobox/);
  });

  it('makes Astryx DropdownMenu the only menu behavior authority', async () => {
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
    await assert.rejects(access(join(UI_ROOT, 'primitives', 'menu.tsx')));
    assert.match(consumers, /from '@astryxdesign\/core\/DropdownMenu'/);
    assert.doesNotMatch(
      consumers,
      /from ['"].*primitives\/menu|queueMicrotask|<Menu(?:Trigger|Popup|Sub)/,
    );

    const barrel = await readUiSource('index.ts');
    assert.doesNotMatch(barrel, /primitives\/menu/);
  });

  it('styles open Astryx menu and picker triggers through their public ARIA state', async () => {
    const [sidebar, modelSwitcher] = await Promise.all([
      readFile(join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles', 'sidebar.css'), 'utf8'),
      readFile(join(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles', 'model-switcher.css'), 'utf8'),
    ]);
    const styles = `${sidebar}\n${modelSwitcher}`;

    assert.doesNotMatch(styles, /(?:maka-list-row-menu|maka-model-switcher)[^{]*data-popup-open/);
    assert.match(sidebar, /\.maka-list-row-menu-trigger\[aria-expanded="true"\]/);
    assert.match(modelSwitcher, /\.maka-model-switcher-trigger\[aria-expanded="true"\]/);
  });

  it('makes Astryx Dialog the only modal behavior authority', async () => {
    const [source, toast] = await Promise.all([
      readUiSource('ui.tsx'),
      readUiSource('toast.tsx'),
    ]);

    await Promise.all([
      assert.rejects(access(join(UI_ROOT, 'modal-lifecycle.ts'))),
      assert.rejects(access(join(UI_ROOT, 'primitives', 'dialog-header.tsx'))),
    ]);
    assert.doesNotMatch(
      source,
      /DialogContext|ModalRoot|createModalContent|DialogClose|buttonVariants|@astryxdesign\/core\/Dialog/,
    );
    assert.doesNotMatch(toast, /useModalFocusLifecycle|modal-lifecycle/);
    assert.match(toast, /AlertDialog as AstryxAlertDialog[\s\S]*from '@astryxdesign\/core\/AlertDialog'/);

    const consumerPaths = [
      'chat-turn.tsx',
      'plan-reminder-form-dialog.tsx',
      'search-modal.tsx',
      'tool-activity.tsx',
    ];
    const consumers = (
      await Promise.all(consumerPaths.map((path) => readUiSource(path)))
    ).join('\n');
    assert.match(consumers, /from '@astryxdesign\/core\/Dialog'/);
    assert.match(consumers, /from '@astryxdesign\/core\/Layout'/);
    assert.doesNotMatch(
      consumers,
      /DialogRoot|DialogContent|DialogClose|initialFocus|finalFocus|primitives\/dialog-header/,
    );
  });

  it('uses one Astryx LayerProvider and Astryx toast lifecycle', async () => {
    const source = await readUiSource('toast.tsx');

    assert.match(source, /LayerProvider[\s\S]*from '@astryxdesign\/core\/Layer'/);
    assert.match(source, /useToast as useAstryxToast[\s\S]*from '@astryxdesign\/core\/Toast'/);
    assert.match(source, /<LayerProvider toast=\{\{ position: 'bottomEnd' \}\}>/);
    assert.doesNotMatch(source, /@base-ui\/react\/toast|createToastManager|BaseToast/);
  });
});
