/**
 * Settings row track contract.
 *
 * `.settingsRow` splits label and control across two grid tracks, and the
 * rule is one sentence: THE LABEL IS THE CONTENT, the right column is the
 * accessory. So the right track is sized to what it holds, capped so it
 * cannot starve the label, and the label takes everything else.
 *
 * The default used to be `minmax(150px, 0.36fr) minmax(0, 1fr)` — the
 * accessory got 1fr and the content was rationed to 0.36fr. #1524 noticed
 * the symptom but fixed it per control bucket, adding `minmax(0, 1fr) auto`
 * for switches and the compact time field while leaving the backwards
 * default in place "for rows whose control fills the value column".
 *
 * No such row exists. Every right column in the app is a switch, a ~94px
 * time field, a select capped at min(320px, 45%), or — 28 rows across the
 * 数据 / 开放网关 / 通用 / 关于 pages, via SettingRow — a short read-only
 * string. So the enumerated exceptions were the rule, and the default was
 * a defect that the contract was holding in place: on a ~1076px row the
 * value used ~64px of a ~791px track while the label was pinned to ~285px
 * and wrapped its hint to four lines, mid-word, because Chinese has no
 * spaces to break at.
 *
 * Stating it as the default is the point — it is what makes the next row
 * someone adds come out right without being enumerated here first.
 *
 * The cap is load-bearing in both directions, which is why the numbers are
 * pinned below:
 *   - bare `auto` sizes to max-content, and the 数据 page's workspace path
 *     is a ~690px unbroken string; that starves the label exactly the way
 *     0.36fr did, just from the other side.
 *   - a select's `w-full` trigger collapses under an intrinsic track
 *     (measured 320px → 118px), and a flat 320px cap eats the label
 *     instead (82px at a 468px card, just above the 460px stacking
 *     breakpoint). Only the both-caps form survives every width.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/** Rule body for an exact selector, anchored so prefixes don't match. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.[\]/+*()>:="-]/g, (ch) => `\\${ch}`);
  const re = new RegExp(`(?:^|\\n|\\})\\s*${escaped}[^{}]*\\{([^}]*)\\}`, 'm');
  return css.match(re)?.[1] ?? '';
}

/** The base `.settingsRow {` rule — no suffix, so `:hover` / `> [role=…]`
 *  and the bucket rules cannot stand in for the base declaration. */
function baseRowBody(css: string): string {
  return css.match(/(?:^|\n|\})\s*\.settingsRow\s*\{([^}]*)\}/)?.[1] ?? '';
}

describe('settings row track contract', () => {
  it('gives the label the flexible track and sizes the value to its content', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const base = baseRowBody(css);
    assert.ok(base, '.settingsRow base rule must exist');

    assert.match(
      base,
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+fit-content\(45%\)/,
      'the label must take the flexible track and the value must size to content under a cap — see the header for why the reverse wrapped Chinese hints mid-word',
    );
  });

  it('caps the value track, because an intrinsic one starves the label too', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const base = baseRowBody(css);

    // `fit-content(45%)`, never a bare `auto`: the workspace path on the
    // 数据 page is a ~690px unbroken string and would claim the row.
    assert.doesNotMatch(
      base,
      /grid-template-columns:[^;]*\s\bauto\b/,
      'a bare auto track sizes to max-content; a long mono path would then starve the label',
    );
  });

  it('never puts a sub-1fr proportional track before the label', async () => {
    const css = stripCssComments(await readAllRendererCss());

    // The shape of the original defect, in any `.settingsRow` rule: a
    // fractional first track smaller than 1fr rations the label by share
    // instead of letting the accessory size itself.
    const offenders = [...css.matchAll(/\.settingsRow[^{}]*\{[^}]*\}/g)]
      .map((m) => m[0])
      .filter((rule) => /grid-template-columns:\s*minmax\([^)]*,\s*0?\.\d+fr\)/.test(rule));

    assert.deepEqual(
      offenders.map((r) => r.split('{')[0].trim()),
      [],
      'a label track narrower than 1fr by share is the backwards split this contract exists to prevent',
    );
  });

  it('caps the select track by BOTH an absolute and a proportional bound', async () => {
    const css = stripCssComments(await readAllRendererCss());
    const select = ruleBody(css, '.settingsRow[data-control-width="select"]');
    assert.ok(select, '.settingsRow[data-control-width="select"] track rule must exist');

    assert.match(
      select,
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*min\(320px,\s*45%\)\)/,
      'select track must be capped by min(320px, 45%) — see the header for what each bound prevents',
    );
    assert.doesNotMatch(
      select,
      /grid-template-columns:[^;]*\bauto\b/,
      'an intrinsic select track collapses the w-full trigger to its selected option text',
    );
  });

  it('keeps switch rows two-column when the card stacks everything else', async () => {
    const css = stripCssComments(await readAllRendererCss());

    // A switch is ~40px and always fits beside its label, so stacking it
    // reads as a detached orphan. This is the one row kind that stays
    // horizontal below the 460px container breakpoint. The selector must
    // stay tag-agnostic: Base UI renders Switch's root as a SPAN, and a
    // tag-qualified rewrite of this selector has rotted silently before.
    assert.match(
      css,
      /\.settingsRow:has\(>\s*\[role="switch"\]\)[^{]*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/,
      'switch-only rows must keep two columns inside the narrow-container block',
    );
  });
});
