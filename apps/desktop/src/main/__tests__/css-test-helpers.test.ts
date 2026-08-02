/**
 * Unit tests for the shared CSS test helpers used by the typography converge
 * contracts (line-height / font-weight / letter-spacing) and other renderer
 * CSS contracts.
 *
 * Two invariants locked here:
 *
 * 1. `expandCssImports` fails closed — a missing/bad `@import` must throw
 *    (surfacing the import path), not silently degrade to reading only the
 *    entry file. Otherwise a converge contract could pass while skipping
 *    every `styles/*` file the convergence is supposed to cover.
 *
 * 2. `findFontShorthandOffenders` bans every non-literal `font:` shorthand
 *    (only `inherit` / `initial` / `unset` / `revert` allowed). This is the
 *    shared backstop for the font-weight and line-height converge contracts,
 *    which scan longhand declarations only and would otherwise miss bare
 *    weight or line-height smuggled in via `font:` shorthand.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import {
  expandCssImports,
  findFontShorthandOffenders,
  assertCustomPropPinnedOnce,
  cssRuleBody,
  cssMediaBody,
  assertCssRuleDecls,
} from './css-test-helpers.js';

describe('css-test-helpers', () => {
  describe('expandCssImports (fail closed on bad @import)', () => {
    let tmpDir: string;
    let entryCss: string;

    it('throws on a missing @import instead of silently degrading', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'css-helpers-'));
      entryCss = join(tmpDir, 'entry.css');
      // entry.css imports a file that does not exist
      await writeFile(entryCss, '@import "./missing.css";\n');

      await assert.rejects(
        () => expandCssImports(entryCss, new Set([entryCss])),
        (err: NodeJS.ErrnoException) => {
          // The error must surface the missing import path, not just the entry.
          assert.ok(
            err.message.includes('missing.css') || err.code === 'ENOENT',
            `error should surface the missing import path; got: ${err.message}`,
          );
          return true;
        },
      );
    });

    after(async () => {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('findFontShorthandOffenders', () => {
    it('accepts literal font: shorthand (inherit / initial / unset / revert)', () => {
      assert.deepEqual(findFontShorthandOffenders('font: inherit', 'test'), []);
      assert.deepEqual(findFontShorthandOffenders('font: initial', 'test'), []);
      assert.deepEqual(findFontShorthandOffenders('font: unset', 'test'), []);
      assert.deepEqual(findFontShorthandOffenders('font: revert', 'test'), []);
    });

    it('rejects non-literal font: shorthand (bare weight, line-height, var() size)', () => {
      assert.ok(findFontShorthandOffenders('font: 600 12px sans-serif', 'test').length > 0, 'bare weight must fail');
      assert.ok(findFontShorthandOffenders('font: bold 12px sans-serif', 'test').length > 0, 'bold keyword must fail');
      assert.ok(findFontShorthandOffenders('font: 12px/1.4 sans-serif', 'test').length > 0, 'bare line-height must fail');
      assert.ok(findFontShorthandOffenders('font: 600 var(--font-size-ui) var(--font-sans)', 'test').length > 0, 'var() size with bare weight must fail');
      assert.ok(findFontShorthandOffenders('font: var(--font-size-ui)/1.4 var(--font-sans)', 'test').length > 0, 'var() size with bare line-height must fail');
    });

    it('ignores font: inside comments', () => {
      assert.deepEqual(findFontShorthandOffenders('/* font: 600 12px sans-serif */', 'test'), []);
    });
  });

  describe('cssRuleBody (stops at the target rule’s closing brace)', () => {
    const sheet = `
.maka-chat-layout {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.maka-chat-layout > :first-child {
  min-height: 0;
  flex: 1 0 auto;
}
.maka-shell-topbar-rail {
  display: flex;
}
.maka-workspace-top-actions {
  -webkit-app-region: no-drag;
}
`;

    it('returns only the matched rule’s own declarations', () => {
      const body = cssRuleBody(sheet, '.maka-chat-layout');
      assert.ok(body);
      assert.match(body!, /display:\s*flex/);
      assert.match(body!, /min-height:\s*0/);
      assert.doesNotMatch(body!, /flex:\s*1\s+0\s+auto/);
    });

    it('fails closed when the property only lives on a later sibling rule', () => {
      // Mutation: drop min-height from .maka-chat-layout; child still has it.
      const mutated = sheet.replace(
        /\.maka-chat-layout\s*\{[^}]*?min-height:\s*0;\s*/s,
        '.maka-chat-layout {\n  display: flex;\n  flex-direction: column;\n',
      );
      const body = cssRuleBody(mutated, '.maka-chat-layout');
      assert.ok(body);
      assert.doesNotMatch(body!, /min-height:\s*0/);
      // The naive cross-rule regex still "passes" — document the bug class.
      const naive = /\.maka-chat-layout\s*\{[\s\S]*?min-height:\s*0;/;
      assert.equal(naive.test(mutated), true, 'naive regex is the false-green pattern');
      assert.throws(
        () => assertCssRuleDecls(mutated, '.maka-chat-layout', [/min-height:\s*0/]),
        /must declare/,
      );
    });

    it('fails closed when no-drag only lives on a later action cluster', () => {
      const body = cssRuleBody(sheet, '.maka-shell-topbar-rail');
      assert.ok(body);
      assert.doesNotMatch(body!, /-webkit-app-region:\s*no-drag/);
      assert.throws(
        () => assertCssRuleDecls(sheet, '.maka-shell-topbar-rail', [/-webkit-app-region:\s*no-drag/]),
        /must declare/,
      );
      assert.doesNotThrow(() =>
        assertCssRuleDecls(sheet, '.maka-workspace-top-actions', [/-webkit-app-region:\s*no-drag/]),
      );
    });

    it('returns null for a missing selector', () => {
      assert.equal(cssRuleBody(sheet, '.does-not-exist'), null);
    });

    it('does not match a right-hand combinator target as the rule selector', () => {
      const withSibling = `
.settingsOsPermissionRow + .settingsOsPermissionRow {
  border-top: 1px solid red;
}
.settingsOsPermissionRow {
  display: flex;
  flex-wrap: wrap;
}
`;
      const body = cssRuleBody(withSibling, '.settingsOsPermissionRow');
      assert.ok(body);
      assert.match(body!, /display:\s*flex/);
      assert.doesNotMatch(body!, /border-top/);
    });
  });

  describe('cssMediaBody', () => {
    const sheet = `
@media (max-width: 620px) {
  .settingsRemoteAccessItemActions {
    display: none;
  }
  .settingsBotStatusGrid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 990px) {
  .maka-session-workbar {
    max-height: min(42dvh, 360px);
  }
}
`;

    it('extracts one media block without bleeding into the next', () => {
      const body = cssMediaBody(sheet, '(max-width: 620px)');
      assert.ok(body);
      assert.match(body!, /\.settingsRemoteAccessItemActions/);
      assert.doesNotMatch(body!, /\.maka-session-workbar/);
      const rule = cssRuleBody(body!, '.settingsRemoteAccessItemActions');
      assert.match(rule!, /display:\s*none/);
    });
  });

  describe('assertCustomPropPinnedOnce', () => {
    it('accepts a single declaration with the exact value', () => {
      assert.doesNotThrow(() => assertCustomPropPinnedOnce('--font-weight-normal: 400;', '--font-weight-normal', '400'));
    });

    it('rejects duplicate token declarations (a later override drifts undetected by assert.match)', () => {
      assert.throws(
        () => assertCustomPropPinnedOnce('--font-weight-normal: 400;\n  --font-weight-normal: 450;', '--font-weight-normal', '400'),
        /exactly once/,
      );
      assert.throws(
        () => assertCustomPropPinnedOnce('--leading-normal: 1.5;\n  --leading-normal: 1.55;', '--leading-normal', '1.5'),
        /exactly once/,
      );
      assert.throws(
        () => assertCustomPropPinnedOnce('--tracking-normal: 0;\n  --tracking-normal: 0.02em;', '--tracking-normal', '0'),
        /exactly once/,
      );
    });

    it('rejects duplicate bridge alias declarations (override drifts undetected by assert.match)', () => {
      assert.throws(
        () => assertCustomPropPinnedOnce('--font-weight-normal: var(--font-weight-normal);\n  --font-weight-normal: 450;', '--font-weight-normal', 'var(--font-weight-normal)'),
        /exactly once/,
      );
      assert.throws(
        () => assertCustomPropPinnedOnce('--leading-normal: var(--leading-normal);\n  --leading-normal: 1.55;', '--leading-normal', 'var(--leading-normal)'),
        /exactly once/,
      );
      assert.throws(
        () => assertCustomPropPinnedOnce('--tracking-normal: var(--tracking-normal);\n  --tracking-normal: 0.02em;', '--tracking-normal', 'var(--tracking-normal)'),
        /exactly once/,
      );
    });

    it('rejects a single declaration with a drifted value', () => {
      assert.throws(
        () => assertCustomPropPinnedOnce('--font-weight-normal: 450;', '--font-weight-normal', '400'),
        /must be 400/,
      );
    });

    it('rejects a missing prop', () => {
      assert.throws(
        () => assertCustomPropPinnedOnce('--other: 1;', '--font-weight-normal', '400'),
        /exactly once/,
      );
    });

    it('strips comments before parsing (inline comment after value)', () => {
      assert.doesNotThrow(() => assertCustomPropPinnedOnce('--leading-none: 1;        /* single-line: kbd */', '--leading-none', '1'));
    });
  });
});