/**
 * PR-DISCLOSURE-COLLAPSIBLE-0 (issue #520 PR5 item 17, 2026-07-05):
 * the remaining disclosure sites migrate off native `<details>`/`<summary>`
 * onto Base UI
 * Collapsible. The code comments at the sites already said "future Base UI
 * Accordion path"; all four are independent single sections (not grouped),
 * so Collapsible (not Accordion) is the right primitive.
 *
 * Why migrate: native `<details>` gives free keyboard a11y but no CSS hook for
 * the open/closed animation state, no controlled-open API for the reasoning
 * panel's "default open, first click sticks" behavior (which today reads
 * `e.currentTarget.open` from the toggle event), and no `data-slot` for the
 * style-hook convention. Base UI Collapsible gives `data-[open]` state, a
 * controlled `open` prop, and the `data-slot` hook.
 *
 * This contract locks the migration: the three files that held the four
 * `<details>` sites must not carry `<details>`/`<summary>` (not even in
 * comments — a stale "wrapped in a <details>" comment is a regression
 * signal), and must import Collapsible. The Collapsible primitive itself
 * must wrap Base UI Collapsible with the data-slot convention (item 23).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

const MIGRATED_FILES = [
  'packages/ui/src/chat-turn.tsx',
  'packages/ui/src/tool-activity.tsx',
];

const COLLAPSIBLE_PRIMITIVE = 'packages/ui/src/primitives/collapsible.tsx';

/** A Collapsible import: from the @maka/ui barrel, the primitives path, or
 *  @base-ui/react/collapsible directly. */
const COLLAPSIBLE_IMPORT_RE = /import\s+\{[^}]*\bCollapsible\b[^}]*\}\s+from\s+['"][^'"]*(?:@maka\/ui|primitives\/collapsible|@base-ui\/react\/collapsible)[^'"]*['"]/;

describe('PR-DISCLOSURE-COLLAPSIBLE-0 contract', () => {
  it('the disclosure sites use Base UI Collapsible (no native <details>/<summary>)', async () => {
    for (const rel of MIGRATED_FILES) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(!/<details\b/.test(src), `${rel}: must not use native <details> (migrate to Base UI Collapsible; also drop stale <details> mentions in comments)`);
      assert.ok(!/<summary\b/.test(src), `${rel}: must not use native <summary> (use Collapsible.Trigger)`);
      assert.match(src, COLLAPSIBLE_IMPORT_RE, `${rel}: must import Collapsible from @maka/ui / primitives/collapsible / @base-ui/react/collapsible`);
    }
  });

  it('primitives/collapsible.tsx wraps Base UI Collapsible with data-slot on Root / Trigger / Panel', async () => {
    const src = await readFile(resolve(REPO_ROOT, COLLAPSIBLE_PRIMITIVE), 'utf8');
    assert.match(src, /@base-ui\/react\/collapsible/, 'must import from @base-ui/react/collapsible');
    for (const slot of ['collapsible', 'collapsible-trigger', 'collapsible-panel']) {
      assert.match(src, new RegExp(`data-slot="${slot}"`), `must expose data-slot="${slot}" (style-hook convention, item 23)`);
    }
  });

  it('tool-activity Collapsible is controlled by the shared disclosure state, not defaultOpen', async () => {
    const src = await readFile(resolve(REPO_ROOT, 'packages/ui/src/tool-activity.tsx'), 'utf8');
    assert.ok(!/defaultOpen=/.test(src), 'tool-activity must not use defaultOpen; shared disclosure state preserves manual choices and surfaces new attention states');
    assert.match(src, /\bonOpenChange\b/, 'tool-activity Collapsible must be controlled via onOpenChange');
    assert.match(src, /useToolDisclosure/, 'tool-activity must route open state through the shared disclosure controller');
  });
});

describe('disclosure-collapsible negative cases', () => {
  it('flags a native <details> and a missing Collapsible import', () => {
    const withDetails = 'import { Collapsible } from "@maka/ui";\nexport function X() { return <details><summary>h</summary>b</details>; }';
    assert.ok(/<details\b/.test(withDetails), '<details> must be detected');
    const noImport = 'export function X() { return null; }';
    assert.ok(!COLLAPSIBLE_IMPORT_RE.test(noImport), 'no Collapsible import must not match');
    const withImport = 'import { Collapsible } from "@maka/ui";\nexport function X() { return <Collapsible.Root />; }';
    assert.ok(COLLAPSIBLE_IMPORT_RE.test(withImport), 'a Collapsible import must match');
  });
});
