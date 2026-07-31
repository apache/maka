/**
 * PR-TOOLTIP-CONVERGE-0 (issue #520 PR5 item 20, 2026-07-05):
 * the icon-only-action button tooltips migrate off the native `title=`
 * attribute (an unstyled, delayed browser tooltip) onto Astryx Tooltip,
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
 * tooltips and stay; truncation spans, picker titles, status-badge
 * icons, and OnboardingHero's submit button ARE tooltip-eligible but each
 * needs a label-vs-tooltip check, so they are not swept in this commit).
 *
 * The contract: consumers use Astryx's public `content` composition directly.
 * Maka must not retain a Base UI-shaped Tooltip compatibility surface.
 */

import { strict as assert } from 'node:assert';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

const MIGRATED_FILES = [
  'apps/desktop/src/renderer/app-shell-chrome-actions.tsx',
  'apps/desktop/src/renderer/browser-panel.tsx',
  'apps/desktop/src/renderer/artifact-pane.tsx',
  'packages/ui/src/chat-turn.tsx',
];

const TOOLTIP_PRIMITIVE = 'packages/ui/src/primitives/tooltip.tsx';
const UI_BARREL = 'packages/ui/src/index.ts';

/** A JSX `title=` attribute (title immediately followed by `=`). JS
 *  `const title =` has a space before `=` so it does not match. */
const TITLE_ATTR_RE = /\btitle=/;

const TOOLTIP_IMPORT_RE =
  /import\s+\{[^}]*\bTooltip\b[^}]*\}\s+from\s+['"]@astryxdesign\/core\/Tooltip['"]/;

describe('PR-TOOLTIP-CONVERGE-0 contract', () => {
  it('the icon-action tooltip files use Astryx Tooltip directly (no native title= attribute)', async () => {
    for (const rel of MIGRATED_FILES) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      if (rel.startsWith('apps/desktop/')) {
        assert.ok(!TITLE_ATTR_RE.test(src), `${rel}: must not use native title=`);
      }
      assert.match(src, TOOLTIP_IMPORT_RE, `${rel}: must import Tooltip from Astryx`);
      assert.match(src, /<Tooltip\s+content=/, `${rel}: must use the public content prop`);
      assert.doesNotMatch(src, /TooltipTrigger|TooltipContent|buttonVariants/);
    }
  });

  it('deletes the retired Tooltip compatibility implementation and barrel exports', async () => {
    await assert.rejects(access(resolve(REPO_ROOT, TOOLTIP_PRIMITIVE)));
    const barrel = await readFile(resolve(REPO_ROOT, UI_BARREL), 'utf8');
    assert.doesNotMatch(barrel, /primitives\/tooltip|TooltipTrigger|TooltipContent/);
  });
});
