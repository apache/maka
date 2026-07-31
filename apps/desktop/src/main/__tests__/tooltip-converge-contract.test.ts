/**
 * PR-TOOLTIP-CONVERGE-0 (issue #520 PR5 item 20, 2026-07-05):
 * the icon-only-action button tooltips migrate off the native `title=`
 * attribute (an unstyled, delayed browser tooltip) onto Base UI Tooltip,
 * which gives a themed, positioned, hover+focus tooltip matching the app.
 *
 * Scope of this commit: the clearest icon-only-action buttons — the app
 * shell chrome actions (search / sidebar / new-task / feedback / command-
 * palette / help / health), the browser-panel nav (back / forward / refresh
 * / close), and the artifact-pane collapse / delete. These are unambiguous
 * icon-only buttons where `title=` is a hover hint, not a visible label.
 *
 * Out of scope (deferred to a follow-up): the longer tail of `title=` usages
 * that need per-site judgment (label-prop components like SettingRow /
 * MetricCard / SetupHero render `title` as visible text — those are NOT
 * tooltips and stay; truncation spans, SelectTrigger titles, status-badge
 * icons, and OnboardingHero's submit button ARE tooltip-eligible but each
 * needs a label-vs-tooltip check, so they are not swept in this commit).
 *
 * The contract: the three migrated files must not carry a `title=` JSX
 * attribute (the tooltip text moves into `<TooltipContent>{...}`) and must
 * import Tooltip; the primitive must wrap Base UI Tooltip with the data-slot
 * convention (item 23).
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

const MIGRATED_FILES = [
  'apps/desktop/src/renderer/app-shell-chrome-actions.tsx',
  'apps/desktop/src/renderer/browser-panel.tsx',
  'apps/desktop/src/renderer/artifact-pane.tsx',
];

const TOOLTIP_PRIMITIVE = 'packages/ui/src/primitives/tooltip.tsx';

/** A JSX `title=` attribute (title immediately followed by `=`). JS
 *  `const title =` has a space before `=` so it does not match. */
const TITLE_ATTR_RE = /\btitle=/;

/** A Tooltip import from the barrel / primitives (the Astryx-backed wrapper). */
const TOOLTIP_IMPORT_RE = /import\s+\{[^}]*\bTooltip\b[^}]*\}\s+from\s+['"][^'"]*(?:@maka\/ui|primitives\/tooltip)[^'"]*['"]/;

describe('PR-TOOLTIP-CONVERGE-0 contract', () => {
  it('the icon-action tooltip files use the shared Tooltip primitive (no native title= attribute)', async () => {
    for (const rel of MIGRATED_FILES) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(!TITLE_ATTR_RE.test(src), `${rel}: must not use native title= (migrate icon-action tooltips to the shared Tooltip primitive)`);
      assert.match(src, TOOLTIP_IMPORT_RE, `${rel}: must import Tooltip from @maka/ui / primitives/tooltip`);
    }
  });

  it('primitives/tooltip.tsx wraps Astryx useTooltip with data-slot on Trigger / Content', async () => {
    const src = await readFile(resolve(REPO_ROOT, TOOLTIP_PRIMITIVE), 'utf8');
    // #1565 PR 5: behavior authority moved from Base UI to Astryx. The frozen
    // Tooltip/TooltipTrigger/TooltipContent composition API stays; behind it a
    // single useTooltip instance drives a native-Popover top-layer surface.
    // The root is a context provider with no DOM node, so only the trigger and
    // content carry data-slot hooks (style-hook convention, item 23).
    assert.match(src, /@astryxdesign\/core\/Tooltip/, 'must import from @astryxdesign/core/Tooltip');
    assert.doesNotMatch(src, /@base-ui\/react\/tooltip/, 'Base UI tooltip must not return — one behavior authority per component (#1565)');
    for (const slot of ['tooltip-trigger', 'tooltip-content']) {
      assert.match(src, new RegExp(`data-slot="${slot}"`), `must expose data-slot="${slot}" (style-hook convention, item 23)`);
    }
  });
});

describe('tooltip-converge negative cases', () => {
  it('TITLE_ATTR_RE matches JSX title= but not JS const title =', () => {
    assert.ok(TITLE_ATTR_RE.test('<Button title="x">'), 'JSX title="x" must match');
    assert.ok(TITLE_ATTR_RE.test('title={label}'), 'JSX title={...} must match');
    assert.ok(!TITLE_ATTR_RE.test('const title = "x"'), 'JS const title = must not match');
  });

  it('TOOLTIP_IMPORT_RE matches a Tooltip import and spares a missing one', () => {
    assert.ok(TOOLTIP_IMPORT_RE.test('import { Tooltip } from "@maka/ui";'), 'barrel import must match');
    assert.ok(TOOLTIP_IMPORT_RE.test("import { Tooltip } from './primitives/tooltip.js';"), 'primitives import must match');
    assert.ok(!TOOLTIP_IMPORT_RE.test('import { Button } from "@maka/ui";'), 'no Tooltip import must not match');
  });
});