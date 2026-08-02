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
 * 2. `findTextRoleOffenders` is the whole text-style vocabulary: a call site
 *    names one role and declares no font longhand. The shorthand inverted
 *    here — it used to be the bypass vector and is now the only legal form,
 *    because it is the one CSS mechanism that makes size, leading, weight and
 *    family inseparable. The undefined-role arm matters most: a `var()` that
 *    resolves to nothing makes the declaration invalid at computed-value time
 *    and the element silently keeps what it inherits.
 *
 * 3. `parseCssBlocks` reports every rule's OWN declarations at any nesting
 *    depth, and reads the last declaration of a repeated property. Both are
 *    silent-failure shapes: the innermost-block-only form it replaced dropped
 *    a nested rule's parent entirely, and a first-match read reports the value
 *    the browser discards. Untested, the pairing contract inherits both.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, after } from 'node:test';
import {
  expandCssImports,
  findTextRoleOffenders,
  parseCssBlocks,
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

  describe('findTextRoleOffenders', () => {
    const TOKENS = ':root { --maka-text-body: 400 14px/1.4 sans; --maka-text-code: 400 14px/1.4 mono; }';
    const find = (css: string) => findTextRoleOffenders(css, TOKENS, 'test');

    it('accepts a defined role token and the whole-inheritance literals', () => {
      assert.deepEqual(find('.a { font: var(--maka-text-body); }'), []);
      assert.deepEqual(find('.a { font: var( --maka-text-code ); }'), []);
      for (const literal of ['inherit', 'initial', 'unset', 'revert']) {
        assert.deepEqual(find(`.a { font: ${literal}; }`), []);
      }
    });

    it('rejects every font longhand at a call site', () => {
      for (const decl of [
        'font-size: var(--font-size-ui)',
        'line-height: 1.4286',
        'font-weight: var(--font-weight-medium)',
        'font-family: var(--font-family-code)',
      ]) {
        assert.equal(find(`.a { ${decl}; }`).length, 1, `${decl} must be reported`);
      }
    });

    it('rejects a hand-composed shorthand — the four choices on one line', () => {
      assert.equal(find('.a { font: 600 12px/1.4 sans-serif; }').length, 1);
      assert.equal(find('.a { font: 600 var(--font-size-lg)/1.4 sans-serif; }').length, 1);
      assert.equal(find('.a { font: var(--font-size-ui); }').length, 1);
    });

    it('rejects a role the table does not define', () => {
      const offenders = find('.a { font: var(--maka-text-display-1); }');
      assert.equal(offenders.length, 1);
      assert.match(offenders[0], /--maka-text-display-1/);
    });

    it('reads the last declaration, so a longhand after a role is still caught', () => {
      assert.equal(find('.a { font: var(--maka-text-body); font-weight: 700; }').length, 1);
    });

    it('rejects a second font declaration, which would make the role line dead', () => {
      const offenders = find('.a { font: var(--maka-text-body); font: inherit; }');
      assert.equal(offenders.length, 1);
      assert.match(offenders[0], /declares font 2 times/);
    });

    it('ignores declarations inside comments', () => {
      assert.deepEqual(find('.a { /* font-size: 12px; */ font: var(--maka-text-body); }'), []);
    });
  });

  describe('parseCssBlocks (own declarations, at any depth)', () => {
    const bodyOf = (css: string, selector: string) =>
      parseCssBlocks(css).find((b) => b.selector === selector)?.body;

    it('keeps a parent rule’s declarations when a nested rule follows them', () => {
      // The regression that motivated replacing the innermost-block-only
      // parser: under it `.a` disappeared entirely, taking its font-size out
      // of the pairing scan and silently exempting the rule.
      const css = '.a { font-size: 18px; & span { color: red; } }';
      assert.match(bodyOf(css, '.a') ?? '', /font-size:\s*18px/);
      assert.match(bodyOf(css, '& span') ?? '', /color:\s*red/);
    });

    it('keeps a parent rule’s declarations that follow the nested rule', () => {
      const css = '.a { & span { color: red; } line-height: 1.9; }';
      assert.match(bodyOf(css, '.a') ?? '', /line-height:\s*1\.9/);
    });

    it('emits rules inside at-rules but not the at-rule body itself', () => {
      const blocks = parseCssBlocks('@media (min-width: 40rem) { .a { font-size: 18px; } }');
      assert.deepEqual(
        blocks.map((b) => b.selector),
        ['.a'],
      );
    });

    it('does not leak a sibling rule’s declarations into a block', () => {
      const css = '.a { font-size: 18px; }\n.b { color: red; }';
      assert.doesNotMatch(bodyOf(css, '.a') ?? '', /color/);
      assert.doesNotMatch(bodyOf(css, '.b') ?? '', /font-size/);
    });

    it('strips comments before parsing', () => {
      assert.doesNotMatch(bodyOf('.a { /* font-size: 18px; */ color: red; }', '.a') ?? '', /18px/);
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