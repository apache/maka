import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

test('Astryx Selector exclusively owns model search, options, keyboard, focus, and popup behavior', async () => {
  const source = await readFile(resolve(REPO_ROOT, 'packages/ui/src/model-picker.tsx'), 'utf8');

  assert.match(source, /import \{[\s\S]*Selector,[\s\S]*SelectorOption[\s\S]*\} from '@astryxdesign\/core\/Selector';/);
  assert.match(source, /buildModelPickerOptions\(props\.groups, props\.leadingOption\)/);
  assert.match(source, /<Selector[\s\S]*options=\{options\}[\s\S]*hasSearch[\s\S]*renderOption=/);
  assert.doesNotMatch(source, /useCombobox|usePopover/);
  assert.doesNotMatch(source, /\bquery\b|filterModelPickerOption|modelPickerHasCatalogMatches/);
  assert.doesNotMatch(source, /<input|role="(?:combobox|listbox|option)"|aria-activedescendant/);
  assert.doesNotMatch(source, /onKeyDown|scrollIntoView|getItemId|highlightedIndex/);
  assert.doesNotMatch(source, /\bfooter\b|pinnedItem|popupClassName/);
});
