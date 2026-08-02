/**
 * Unit tests for the shared CSS test helpers used by the type-scale contract
 * and other renderer CSS contracts.
 *
 * Four invariants locked here:
 *
 * 1. `expandCssImports` fails closed — a missing/bad `@import` must throw
 *    (surfacing the import path), not silently degrade to reading only the
 *    entry file. Otherwise a converge contract could pass while skipping
 *    every `styles/*` file the convergence is supposed to cover.
 *
 * 2. `findTextRoleOffenders` is the whole text-style vocabulary: a rule names
 *    one role and declares no font longhand. The shorthand inverted here — it
 *    used to be the bypass vector and is now the only legal form, because it
 *    is the one CSS mechanism that makes size, leading, weight and family
 *    inseparable. Two arms matter most, because both are silent: a `var()`
 *    that resolves to nothing makes the declaration invalid at computed-value
 *    time and the element keeps what it inherits, and a type token rebound to
 *    a VALUE reopens all four axes while the call site still names one role.
 *
 * 3. `parseCssBlocks` reports every declaring context's OWN declarations at
 *    any nesting depth, including a rule-nested at-rule, and reads the last
 *    declaration of a repeated property. All three are silent-failure shapes:
 *    the hand-rolled parser this replaced dropped at-rule bodies whole, and a
 *    first-match read reports the value the browser discards.
 *
 * 4. `stripCssComments` does not treat a comment delimiter inside a string as
 *    structural. The naive form deletes real declarations between them.
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
  stripCssComments,
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

    it('reads a property name case-insensitively, as CSS does', () => {
      // `font-size` and `FONT-SIZE` are the same property. The scan this
      // replaced lost the `i` flag its predecessor had, so an upper-cased
      // longhand walked through. Biome does not format apps/desktop or
      // packages/ui, so nothing else normalizes the source either.
      assert.equal(find('.a { FONT-SIZE: 12px; }').length, 1);
      assert.equal(find('.a { Line-Height: 1.9; }').length, 1);
      assert.equal(find('.a { FONT : 600 12px/1.4 sans; }').length, 1);
    });

    it('rejects a type token rebound to a value, at any rule', () => {
      // One line, and the call site below it still names exactly one role
      // while having re-chosen size, leading, weight and family.
      const offenders = find(
        '.a { --maka-text-body: 700 44px/1.05 Impact; font: var(--maka-text-body); }',
      );
      assert.equal(offenders.length, 1);
      assert.match(offenders[0], /never to a value/);
      // The family axis is a type token too — it fills the shorthand's
      // mandatory family slot for every role.
      assert.equal(find('.a { --maka-font-family: "Comic Sans", cursive; }').length, 1);
      // Astryx's own atoms, including the wrapped forms a digit-prefix ban
      // never saw.
      assert.equal(find('.a { --text-body-leading: calc(2.5); }').length, 1);
      assert.equal(find('.a { --text-body-size: max(24px, 1rem); }').length, 1);
    });

    it('accepts a type token rebound to another token', () => {
      // The transcript does exactly this to retune the disclosure rows, and
      // it is the mechanism that keeps a retune inside the scale.
      assert.deepEqual(find('.a { --text-supporting-leading: var(--maka-line-body); }'), []);
      assert.deepEqual(
        find('.a { --maka-text-body: var(--text-body-weight) var(--text-body-size)/var(--text-body-leading) var(--maka-font-family); }'),
        [],
      );
      assert.deepEqual(find('.a { --maka-font-family: var(--font-family-code, var(--font-family-body)); }'), []);
    });

    it('sees declarations inside an at-rule nested in a rule', () => {
      // The hole that made the previous parser's ban conditional on nobody
      // using the shape Astryx itself uses for coarse pointers.
      const offenders = find(
        '.a { font: var(--maka-text-body); @media (pointer: coarse) { font-size: 16px; } }',
      );
      assert.equal(offenders.length, 1);
      assert.match(offenders[0], /@media \(pointer: coarse\) declares font-size/);
    });

    it('does not count a media-nested role against the base rule', () => {
      // Two cascade contexts, one role each — not "declares font 2 times".
      assert.deepEqual(
        find('.a { font: var(--maka-text-body); @media (pointer: coarse) { font: var(--maka-text-code); } }'),
        [],
      );
    });

    it('is not fooled by a brace inside a string', () => {
      const offenders = find('.a::after { content: "}"; font-size: 40px; }');
      assert.equal(offenders.length, 1);
      assert.match(offenders[0], /declares font-size/);
    });

    it('rejects a selector given a role by two rules in the same context', () => {
      // The grouped-role shape: the group's role is dead, and a later retune
      // of the group moves every other member while this one stays put.
      // Measured, `.plan-proposal-kicker` had already drifted a size tier.
      const offenders = find(
        '.a, .b { font: var(--maka-text-body); }\n.a { font: var(--maka-text-code); }',
      );
      assert.equal(offenders.length, 1);
      assert.match(offenders[0], /\.a is given a text role by more than one rule/);
    });

    it('allows the same selector to name a role in a different cascade context', () => {
      // A responsive or layered variant is a replacement, not a duplicate.
      assert.deepEqual(
        find('.a { font: var(--maka-text-body); }\n@media (pointer: coarse) { .a { font: var(--maka-text-code); } }'),
        [],
      );
      // A comma inside :is()/:where() is not a selector-list separator.
      assert.deepEqual(find(':is(.a, .b) { font: var(--maka-text-body); }\n.a { font: var(--maka-text-code); }'), []);
    });

    it('exempts only the code element group’s family longhand', () => {
      // The one declaration in the renderer that must be a longhand: a bare
      // <code> inside migrated prose inherits a resolved family string, which
      // no variable rebind can reach.
      assert.deepEqual(find(':where(code, kbd, samp, pre) { font-family: var(--font-family-code); }'), []);
      assert.equal(find(':where(code, kbd, samp, pre) { font-size: 12px; }').length, 1);
      assert.equal(find('.a { font-family: var(--font-family-code); }').length, 1);
    });
  });

  describe('stripCssComments', () => {
    it('does not treat a comment delimiter inside a string as structural', () => {
      const css = '.a { content: "/*"; font-size: 99px; --tail: "*/"; }';
      assert.match(stripCssComments(css), /font-size:\s*99px/);
    });

    it('still removes a real comment', () => {
      assert.doesNotMatch(stripCssComments('.a { /* font-size: 99px; */ color: red; }'), /99px/);
    });
  });

  describe('parseCssBlocks (own declarations, at any depth)', () => {
    const declsOf = (css: string, selector: string) =>
      parseCssBlocks(css).find((b) => b.selector === selector)?.decls ?? [];
    const props = (css: string, selector: string) => declsOf(css, selector).map((d) => d.prop);

    it('keeps a parent rule’s declarations when a nested rule follows them', () => {
      const css = '.a { font-size: 18px; & span { color: red; } }';
      assert.deepEqual(props(css, '.a'), ['font-size']);
      assert.deepEqual(props(css, '& span'), ['color']);
    });

    it('keeps a parent rule’s declarations that follow the nested rule', () => {
      assert.deepEqual(props('.a { & span { color: red; } line-height: 1.9; }', '.a'), ['line-height']);
    });

    it('emits rules inside a top-level at-rule, not the at-rule itself', () => {
      const blocks = parseCssBlocks('@media (min-width: 40rem) { .a { font-size: 18px; } }');
      assert.deepEqual(blocks.map((b) => b.selector), ['.a']);
    });

    it('emits a rule-nested at-rule as its own context, attributed to the rule', () => {
      // Its declarations apply to the rule's selector but in a different
      // cascade context, so they are neither dropped nor merged.
      const blocks = parseCssBlocks('.a { color: red; @media (pointer: coarse) { font-size: 16px; } }');
      assert.deepEqual(blocks.map((b) => [b.selector, b.rule, b.decls.map((d) => d.prop)]), [
        ['.a', '.a', ['color']],
        ['.a @media (pointer: coarse)', '.a', ['font-size']],
      ]);
    });

    it('skips a top-level declaration at-rule, which is a definition not a call site', () => {
      assert.deepEqual(parseCssBlocks('@font-face { font-family: Bad; src: url(x); }'), []);
    });

    it('does not leak a sibling rule’s declarations into a block', () => {
      const css = '.a { font-size: 18px; }\n.b { color: red; }';
      assert.deepEqual(props(css, '.a'), ['font-size']);
      assert.deepEqual(props(css, '.b'), ['color']);
    });

    it('does not end a rule at a brace inside a string', () => {
      assert.deepEqual(props('.a::after { content: "}"; font-size: 40px; }', '.a::after'), [
        'content',
        'font-size',
      ]);
    });

    it('lower-cases property names, as CSS matching does', () => {
      assert.deepEqual(props('.a { FONT-SIZE: 18px; }', '.a'), ['font-size']);
    });

    it('ignores comments', () => {
      assert.deepEqual(props('.a { /* font-size: 18px; */ color: red; }', '.a'), ['color']);
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