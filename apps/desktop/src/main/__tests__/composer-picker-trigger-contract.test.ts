import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, relativePath), 'utf8');
}

test('composer permission keeps quiet chrome while model controls use Astryx Selector chrome', async () => {
  const [composer, permissionMode, chatModelSwitcher, modelPicker] = await Promise.all([
    read('packages/ui/src/composer.tsx'),
    read('packages/ui/src/permission-mode-menu.tsx'),
    read('packages/ui/src/chat-model-switcher.tsx'),
    read('packages/ui/src/model-picker.tsx'),
  ]);

  assert.match(
    composer,
    /<PermissionModeSelect[\s\S]*?appearance="quiet"[\s\S]*?activeMode=/,
    'the composer permission picker must opt out of field chrome',
  );
  assert.match(
    permissionMode,
    /width=\{props\.appearance === 'quiet' \? undefined : 320\}/,
    'PermissionModeSelect must leave quiet-trigger geometry to its owning surface',
  );

  const composerModelPickers = chatModelSwitcher.match(/<ModelPicker[\s\S]*?>/g) ?? [];
  assert.equal(composerModelPickers.length, 2, 'both composer model picker variants must remain on the shared ModelPicker');
  for (const picker of composerModelPickers) {
    assert.doesNotMatch(picker, /triggerAppearance=/, 'model pickers must not recreate a quiet-trigger variant outside Astryx');
  }
  assert.match(
    modelPicker,
    /<Selector[\s\S]*className=\{props\.triggerClassName\}/,
    'ModelPicker must compose the Astryx Selector and leave its chrome intact',
  );
  assert.doesNotMatch(modelPicker, /pickerTriggerClasses|\.\/ui\.js/);
});
