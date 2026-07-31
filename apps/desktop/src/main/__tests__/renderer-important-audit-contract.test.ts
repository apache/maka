import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { REPO_ROOT, readCssTree, stripCssComments } from './css-test-helpers.js';

type ImportantAllowance = {
  fileSuffix: string;
  anchor: string;
  reason: string;
};

const ALLOWLIST: ImportantAllowance[] = [
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/base.css',
    anchor: '.maka-visually-hidden',
    reason: 'a11y hidden content utility',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/base.css',
    anchor: '[data-maka-reduced-motion="true"] *',
    reason: 'reduced-motion smoke/a11y override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/base.css',
    anchor: '[data-maka-e2e-fixture="true"] *',
    reason: 'deterministic e2e-fixture override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/maka-tokens.css',
    anchor: '@media (prefers-reduced-motion: reduce)',
    reason: 'global reduced-motion token override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/reference-shell.css',
    anchor: '.agents-sidebar',
    reason: 'shared sidebar/session primitive chrome reset',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/reference-shell.css',
    anchor: '.agents-sidebar[data-resizing="true"]',
    reason: 'shared sidebar/session primitive chrome reset',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/reference-shell.css',
    anchor: '.maka-session-panel.agents-sidebar',
    reason: 'shared sidebar/session primitive chrome reset',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/module-pages/skills.css',
    anchor: '.maka-skill-library-row',
    reason: 'shared ghost button layout override',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/empty-state.css',
    anchor: '.maka-session-list .maka-session-empty-state',
    reason: 'shared empty-state card reset (relocated from onboarding.css — issue #546 PR3)',
  },
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/settings/nav-sidebar.css',
    anchor: '@media (prefers-reduced-motion: reduce)',
    reason: 'reduced-motion override',
  },
  {
    // Settings row primitives (consolidated from nav-sidebar.css). Goes
    // through the allowlist + `Justified:` path, NOT isA11yOnlyFile: the
    // file is the style home for every Settings row, so a whole-file skip
    // would blind the audit to future non-a11y `!important` there.
    fileSuffix: 'apps/desktop/src/renderer/styles/settings/rows.css',
    anchor: '@media (prefers-reduced-motion: reduce)',
    reason: 'reduced-motion override',
  },
];

const RETIRED_RING_RESET_BLOCKS = [
  {
    fileSuffix: 'apps/desktop/src/renderer/styles/composer.css',
    anchor: '.composer .maka-composer-textarea',
  },
];

function isAllowed(file: string, source: string): boolean {
  return ALLOWLIST.some((entry) => file.endsWith(entry.fileSuffix) && source.includes(entry.anchor));
}

function isA11yOnlyFile(file: string): boolean {
  return (
    file.endsWith('apps/desktop/src/renderer/styles/base.css') ||
    file.endsWith('apps/desktop/src/renderer/maka-tokens.css') ||
    file.endsWith('apps/desktop/src/renderer/styles/settings/nav-sidebar.css')
  );
}

function readRuleBody(source: string, anchor: string): string | null {
  const start = source.indexOf(anchor);
  if (start === -1) return null;

  const open = source.indexOf('{', start);
  if (open === -1) return null;

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }

  return null;
}

describe('renderer !important audit contract', () => {
  it('keeps the e2e-fixture deterministic-render CSS hooks in sync with the renderer attribute write', async () => {
    // The renderer writes `data-maka-e2e-fixture="true"` on <html>
    // (app-shell-e2e-fixture.ts); base.css must remove decorative
    // animation and sidebar.css must stop the running-status spinner
    // under that attribute, or fixture renders drift non-deterministically.
    // base.css is an isA11yOnlyFile in the !important audit below (skipped
    // wholesale), so this asserts the selectors directly.
    const base = await readFile(`${REPO_ROOT}/apps/desktop/src/renderer/styles/base.css`, 'utf8');
    const sidebar = await readFile(`${REPO_ROOT}/apps/desktop/src/renderer/styles/sidebar.css`, 'utf8');
    assert.match(
      base,
      /\[data-maka-e2e-fixture="true"\] \*[\s\S]*?animation:\s*none\s*!important/,
      'base.css must remove decorative animation under the e2e-fixture attribute so backwards fill modes cannot freeze hidden entry frames',
    );
    assert.doesNotMatch(
      base,
      /\[data-maka-e2e-fixture="true"\][\s\S]*?animation-play-state:\s*paused/,
      'pausing at time zero freezes backwards-filled entry animations in their hidden state',
    );
    assert.match(
      sidebar,
      /\[data-maka-e2e-fixture="true"\] \.maka-list-row-status-icon\[data-status="running"\] svg/,
      'sidebar.css must stop the running-status spinner under the e2e-fixture attribute',
    );
  });

  it('keeps non-a11y `!important` sites explicitly justified and allowlisted', async () => {
    const rendererRoot = `${REPO_ROOT}/apps/desktop/src/renderer`;
    const styleFiles = [
      `${rendererRoot}/reference-shell.css`,
      `${rendererRoot}/maka-tokens.css`,
      ...(await readCssTree(`${rendererRoot}/styles`)),
    ];

    const violations: string[] = [];
    for (const file of styleFiles.sort()) {
      const source = await readFile(file, 'utf8');
      if (!source.includes('!important')) continue;

      const importantSites = [...source.matchAll(/!important/g)];
      if (importantSites.length === 0) continue;

      if (isA11yOnlyFile(file)) {
        continue;
      }

      if (!source.includes('Justified:') || !isAllowed(file, source)) {
        violations.push(file.replace(REPO_ROOT + '/', ''));
      }
    }

    assert.deepEqual(
      violations,
      [],
      'Non-a11y `!important` usage must be explicitly justified in-file and tracked in renderer-important-audit-contract.test.ts.',
    );
  });

  it('retires the renderer-wide field focus override so each control owns focus chrome', async () => {
    const styles = await readFile(`${REPO_ROOT}/apps/desktop/src/renderer/styles.css`, 'utf8');
    assert.doesNotMatch(styles, /field-focus\.css/, 'Astryx and product-native controls must not share a global focus-ring authority');

    for (const entry of RETIRED_RING_RESET_BLOCKS) {
      const file = `${REPO_ROOT}/${entry.fileSuffix}`;
      const source = stripCssComments(await readFile(file, 'utf8'));
      const body = readRuleBody(source, entry.anchor);
      assert.notEqual(body, null, `${entry.anchor} rule not found in ${entry.fileSuffix}`);
      assert.doesNotMatch(
        body ?? '',
        /!important|--tw-ring-(?:offset-)?shadow/,
        `${entry.anchor} must own its focus chrome without resetting a second primitive ring.`,
      );
    }
  });
});
