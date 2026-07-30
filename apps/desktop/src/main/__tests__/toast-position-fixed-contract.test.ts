import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

describe('fixed toast position contract', () => {
  it('keeps toast position out of persisted settings and the Settings UI', async () => {
    const coreSettings = await readRepo('packages/core/src/settings.ts');
    const coreIndex = await readRepo('packages/core/src/index.ts');
    const settingsModal = await readSettingsCombinedSource();
    const rendererMain = await readRendererShellCombinedSource();
    const styles = await readRendererContractCss();

    assert.doesNotMatch(coreSettings, /\bTOAST_POSITIONS\b|\bToastPosition\b|\bisToastPosition\b|toastPosition\?:/, 'core settings must not expose a toast position setting');
    assert.doesNotMatch(coreIndex, /\bTOAST_POSITIONS\b|\bToastPosition\b|\bisToastPosition\b/, 'core public exports must not expose removed toast position contracts');
    assert.doesNotMatch(settingsModal, /TOAST_POSITION_OPTIONS|onToastPositionChange|toastPosition|settingsToastPosition|通知位置/, 'Settings theme UI must not keep the removed toast position picker');
    assert.doesNotMatch(rendererMain, /maka-toast-position-v1|readPersistedToastPosition|onToastPositionChange|<ToastProvider\s+position=/, 'renderer boot must not keep localStorage or prop threading for toast position');
    assert.doesNotMatch(styles, /settingsToastPosition|data-position="top-|data-position="bottom-left"|data-position="bottom-center"/, 'CSS must not keep the removed picker or unused toast corners');
  });

  it('pins the Astryx toast layer to bottom-end in the UI package', async () => {
    const toast = await readRepo('packages/ui/src/toast.tsx');

    assert.match(toast, /<LayerProvider toast=\{\{ position: 'bottomEnd' \}\}>/, 'toast viewport should use the fixed logical bottom-end position');
    assert.doesNotMatch(toast, /position\?:|props\.position|isToastPosition|ToastPosition/, 'ToastProvider must not accept a position prop');
  });
});
