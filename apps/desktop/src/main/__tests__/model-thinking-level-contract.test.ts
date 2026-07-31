import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

async function readSwitcher(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-model-switcher.tsx'), 'utf8');
}

describe('model thinking-level selector contract', () => {
  it('renders thinking level as an adjacent Astryx Selector instead of a nested popup', async () => {
    const source = await readSwitcher();

    assert.match(source, /function ThinkingLevelSelector/);
    assert.match(source, /<Selector[\s\S]*label=\{copy\.thinkingLevel\}[\s\S]*options=\{options\}/);
    assert.match(source, /className="maka-model-selection-controls"/);
    assert.equal(source.match(/<ThinkingLevelSelector/g)?.length, 2, 'session and new-chat controls both compose the adjacent selector');
    assert.doesNotMatch(source, /DropdownMenu|DropdownMenuItem/);
    assert.doesNotMatch(source, /\bfooter=|parentOpen|onCommit|maka-thinking-(?:section|flyout)/);
  });

  it('maps the default sentinel and every supported level through localized option labels', async () => {
    const source = await readSwitcher();

    assert.match(source, /const DEFAULT_THINKING_LEVEL = '__default__'/);
    assert.match(source, /\{ value: DEFAULT_THINKING_LEVEL, label: copy\.defaultLevel \}/);
    assert.match(source, /props\.levels\.map\(\(level\) => \(\{ value: level, label: copy\.level\[level\] \}\)\)/);
    assert.match(
      source,
      /value === DEFAULT_THINKING_LEVEL \? undefined : value as ThinkingLevel/,
    );
  });

  it('delegates persistence to Selector changeAction and shares session pending', async () => {
    const source = await readSwitcher();

    assert.match(
      source,
      /changeAction=\{\(value\) =>[\s\S]*props\.onChange\?\.\(/,
      'Astryx must own the optimistic action promise',
    );
    assert.match(
      source,
      /<ThinkingLevelSelector[\s\S]*disabled=\{pending\}[\s\S]*loading=\{pending\}/,
      'the adjacent session selectors must share the AppShell pending state',
    );
    assert.doesNotMatch(source, /selectionGuard|selectionPending|createModelSelectionGuard/);
  });
});
