import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

// The one thing the type-scale CSS contracts cannot prove.
//
// `type-scale-contract.test.ts` locks the three declarations the scale rests
// on — root unpinned, generated theme layered after the Astryx component
// sheet, and no product name for a size, a family or a leading at all. What no
// amount of text can show is
// what those three resolve to together in a real document: a custom property
// is declared in one place and read in another, and whether the read sees the
// theme depends on layer order, `@scope` roots and tree position interacting.
// That is not hypothetical — an earlier revision of this work shipped the
// aliases against a layer order under which the generated theme applied
// nowhere at all, and every file still read correctly.
//
// So this measures, per AGENTS.md's rule for cascade conclusions. One window,
// no new fixture: the disclosure-output scenario already boots a transcript
// with a live tool row, which is also the surface that most needed the retune.
//
// Deliberately NOT here: Markdown heading sizes. Astryx's heading atoms sit
// in `astryx-components` and the contract already asserts `components` is the
// last layer, so the product rule wins transitively whatever its specificity.
//
// The monospace routing IS here, and the reason is worth stating: it looked
// like a text fact and is not one. Astryx's reset declares the identical
// zero-specificity `:where(code, kbd, samp, pre)` selector, so which stack a
// `<code>` gets is decided by `reset` preceding `base` — an ordering no
// contract in this repo asserts. Asserting the rule's text only proves it was
// written, not that it wins.
/**
 * A chip's box, its parent's box, and its own natural floor, measured before
 * and after its leading is forced to 40px.
 *
 * One helper rather than the same twenty lines pasted at each call site: the
 * probe is subtle (it must restore what it mutates, read the floor with the
 * pin lifted, and measure the PARENT as well as the box) and two copies of a
 * subtle probe drift into two different measurements of the same thing.
 *
 * Bumped to 40px rather than nudged, so the assertion is "did not move at all"
 * instead of "moved within tolerance". Measured on the parent as well, because
 * a non-replaced `display: inline` chip's own border-box height is its font
 * content area and does not track leading at all — a probe that reads only the
 * chip reports "did not move" for a chip whose line box is pushing its row
 * open. The parent delta is the one measure that covers inline, block and flex.
 *
 * `natural` is the floor, measured rather than computed: what this box would be
 * if it were not pinned — its line box plus its own padding and border. A tier
 * below that number does not clip visibly (the line box centres and the ink
 * still fits) but it silently voids the padding the rule declares, which is how
 * eleven chips shipped 2-4px shorter than they read.
 */
async function measureUnderLeadingBump(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el: HTMLElement) => {
    const parent = el.parentElement!;
    const before = el.getBoundingClientRect().height;
    const parentBefore = parent.getBoundingClientRect().height;
    el.style.setProperty('height', 'auto', 'important');
    const natural = el.getBoundingClientRect().height;
    el.style.removeProperty('height');
    el.style.setProperty('line-height', '40px', 'important');
    const after = el.getBoundingClientRect().height;
    const parentAfter = parent.getBoundingClientRect().height;
    el.style.removeProperty('line-height');
    return { before, after, natural, parentBefore, parentAfter };
  });
}

/** The four assertions every pinned chip owes, in one place so a new chip is a
 * one-line addition rather than another copy of the probe. */
function expectHoldsItsBox(box: Awaited<ReturnType<typeof measureUnderLeadingBump>>, selector: string, tier: number) {
  expect(box.before, `${selector} sits on its declared tier`).toBe(tier);
  expect(box.after, `${selector} must not move with its leading`).toBe(box.before);
  expect(box.parentAfter, `${selector} must not push its row open`).toBe(box.parentBefore);
  expect(box.natural, `${selector} must sit on a tier that holds its own floor`).toBeLessThanOrEqual(box.before);
}

test('resolves one type scale from the root down to the transcript', async ({
  disclosureOutputWindow: page,
}) => {
  // Resolve a token AT :root and report the used length in px. Measuring
  // rather than string-comparing the declaration: Chromium normalizes
  // `0.875rem` to `.875rem`, and px is the number the design decision is
  // actually about. The probe hangs off <html> so it sees exactly what a
  // portaled Astryx component outside the Theme wrapper sees.
  const rootRolePx = (role: string) =>
    page.evaluate((name) => {
      const probe = document.createElement('div');
      probe.style.font = `var(${name})`;
      document.documentElement.append(probe);
      const px = getComputedStyle(probe).fontSize;
      probe.remove();
      return px;
    }, role);

  await test.step('the root is the browser default, not a density knob', async () => {
    // 13px here would silently rescale the whole rem-based ladder, plus
    // Astryx's rem-sized Icon atoms, which it documents as the px-equivalents
    // at a 16px root.
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
    ).toBe('16px');
  });

  await test.step('the roles resolve to Maka ladder rungs at :root', async () => {
    // Resolved AT :root, which is also where a portaled Astryx component
    // reads them. Measured on main, the wrong layer order left the generated
    // theme inert at BOTH `<html>` and the inner Theme wrapper — see the note
    // in cascade-layers.css — so this probe is not merely covering an edge.
    //
    // This used to read four product size aliases (--font-size-heading/stat/
    // ui/caption). Those names are gone: a call site names a role, so the
    // aliases reached zero consumers. Probing the ROLE instead is what the
    // product actually reads, and it measures one more link of the chain —
    // the role table composing on `:root` — for the same window. Note the
    // probe assigns `font:`, not `font-size:`, because that is the only shape
    // the role token has.
    //
    // heading-3 and heading-1 are the discriminating pair: Astryx's neutral
    // default (`{base: 14, ratio: 1.2}`) happens to agree with Maka on base
    // and sm, but puts lg at 17px and 2xl at 24px. If the theme ever stops
    // winning at :root, those two are what move.
    expect(await rootRolePx('--maka-text-heading-3')).toBe('16px'); // neutral: 17
    expect(await rootRolePx('--maka-text-heading-1')).toBe('20px'); // neutral: 24
    expect(await rootRolePx('--maka-text-body')).toBe('14px');
    expect(await rootRolePx('--maka-text-supporting')).toBe('12px');
  });

  await test.step('body copy and the tool disclosure share the body tier', async () => {
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('14px');

    // The reasoning/tool rows carry real content — what the agent is doing —
    // and Astryx styles their inner spans as `supporting`. The transcript
    // pulls them back to body size; de-emphasis stays with weight and colour.
    //
    // Assert the ROLE TOKEN on the trigger, not just one span's size. The
    // token is what makes this independent of Astryx's child order: an
    // earlier revision styled `> span:not(:last-child)` and silently missed
    // ChatReasoning, which nests its label one <div> deeper. Anything that
    // opts into the supporting role inherits this, at any depth.
    //
    // Known gap, stated rather than hidden: only ChatToolCalls is probed
    // live. No e2e fixture renders a ChatReasoning row today, and seeding one
    // means adding live-turn data to a shared scenario every other spec also
    // sees. The rebind names both components in one selector and works by
    // inheritance, so it cannot reach one and miss the other for the
    // DOM-shape reason the old rule did — the contract test pins that
    // selector's text. What stays uncovered is an Astryx upgrade that stops
    // styling ChatReasoning's label with the supporting role at all.
    const trigger = page
      .locator('.maka-turn .astryx-chat-tool-calls [role="button"]')
      .first();
    await expect(trigger).toBeVisible();
    expect(
      await trigger.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.fontSize = 'var(--text-supporting-size)';
        el.append(probe);
        const px = getComputedStyle(probe).fontSize;
        probe.remove();
        return px;
      }),
    ).toBe('14px'); // Astryx's supporting role is 12px on this ladder

    // The leading half of the same rebind, and the only check that
    // `--maka-line-body` resolves to a real length. It is the one derived
    // token here (`calc(--text-body-size * --text-body-leading)`); if its
    // definition goes missing, `line-height: <invalid>` falls back to normal
    // leading, which reads as slightly loose text rather than as a break.
    // Compared with a tolerance, not as a string: the leading is a unitless
    // ratio the theme rounds to 1.4286, so the product lands on 20.0004px.
    // Pinning the exact string would make this fail on a rounding change that
    // moves nothing a reader could see.
    expect(
      await trigger.evaluate((el) => {
        const probe = document.createElement('span');
        probe.style.lineHeight = 'var(--text-supporting-leading)';
        el.append(probe);
        const leading = Number.parseFloat(getComputedStyle(probe).lineHeight);
        probe.remove();
        return leading;
      }),
    ).toBeCloseTo(20, 1);

    // And that something actually consumes it: ChatToolCalls puts its call
    // name in the second direct span (the same one the font-family rule in
    // chat-message.css has always targeted).
    const label = trigger.locator('> span:nth-child(2)');
    await expect(label).toBeVisible();
    expect(await label.evaluate((el) => getComputedStyle(el).fontSize)).toBe('14px');
  });

  await test.step('the document default leading pairs with the body tier', async () => {
    // The single highest-leverage line in the leading convergence, and one no
    // stylesheet in this repo used to own: Astryx's reset declares
    // `line-height: 1.5` on `:where(html)`, so every element that did not
    // declare a leading inherited that ratio — measured 21px at the 14px body
    // tier, on hundreds of nodes. `body` in maka-tokens.css now declares the
    // body role's leading next to the body size it already declared.
    expect(
      Number.parseFloat(
        await page.evaluate(() => getComputedStyle(document.body).lineHeight),
      ),
    ).toBeCloseTo(20, 1);
  });

  await test.step('every rendered line box sits on the 4px grid', async () => {
    // The measurement the pairing contract cannot make. That contract reads
    // co-located declarations; this asks the resolved document, which is where
    // an inherited ratio meets an overridden size — the failure that had
    // `.maka-attachment-file-content` holding one 1.25 for a 14px name and a
    // 12px size at once, and `.maka-onboarding-setup header h1` taking a 16px
    // rule's leading at 18px.
    //
    // The grid rule is Astryx's own (expandTypeScale.ts `computeLeading`):
    // target 1.5 under 20px, 1.4 through 31px, 1.25 above, snapped to 4px,
    // floored at the next 4px step at or above size + 4. Recomputed here
    // rather than table-copied so an Astryx scale change moves the
    // expectation with it — which only works if it is the same arithmetic:
    // an earlier revision floored at `size + 4` instead of rounding that
    // floor up to the grid, and at a 9px tier would have accepted 13px and
    // rejected Astryx's own 16px.
    //
    // Scope stated with the measured number rather than hidden: this window
    // renders 129 elements with their own text, and of the 323 classes whose
    // rules declare a leading, 3 land on one. Sweeping every scenario would
    // import other surfaces' vendor gaps, and an allowlist keyed to generated
    // atom class names would rot on the next Astryx build. TextArea has two:
    // its counter row declares --text-supporting-size with no matching leading
    // (off-grid in the plan-reminders window, measured), and its input raises
    // the size to `max(1rem, --text-body-size)` under `(pointer: coarse)`
    // without raising the leading with it — 16px against the 14px tier's
    // 1.4286, so 22.86px where the grid wants 24. Both are upstream: this
    // sweep is first-party CSS's guard, and vendor component styles are not
    // in any scan in this repo.
    //
    // So this is not the repo-wide guard and must not be described as one:
    // what it covers is the one thing text cannot, an inherited ratio meeting
    // an overridden size in a resolved document. Repo-wide, the size and the
    // leading now arrive together or not at all — no rule may declare either
    // longhand, and the role that supplies both may only be rebound to another
    // token (type-scale-contract.test.ts). The pairing contract that used to
    // resolve the two through the generated theme is gone with the properties
    // it compared. What survives it is exactly this sweep, because a role can
    // still be inherited onto an element whose size came from somewhere else.
    const offGrid = await page.evaluate(() => {
      const grid = (px: number) => {
        const target = px < 20 ? 1.5 : px < 32 ? 1.4 : 1.25;
        return Math.max(Math.round((px * target) / 4) * 4, Math.ceil((px + 4) / 4) * 4);
      };
      const out: string[] = [];
      for (const el of document.querySelectorAll('*')) {
        const hasOwnText = [...el.childNodes].some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
        );
        if (!hasOwnText) continue;
        const style = getComputedStyle(el);
        const size = Number.parseFloat(style.fontSize);
        const leading = Number.parseFloat(style.lineHeight);
        if (!Number.isFinite(leading)) continue; // `normal` — no declared leading to check
        const want = grid(size);
        if (Math.abs(leading - want) < 0.51) continue;
        const name = typeof el.className === 'string' ? el.className.split(' ')[0] : '';
        out.push(`${el.tagName.toLowerCase()}.${name}: ${size}px leading ${leading}px, grid wants ${want}px`);
      }
      return [...new Set(out)];
    });
    expect(offGrid).toEqual([]);
  });

  await test.step('a chip box does not move when its own leading does', async () => {
    // #1879. The whole file above proves the leading is one scale; this asks
    // the question that outlives any particular leading — can a leading change
    // still be a layout change? A pinned box says no by construction, and the
    // only way to show it is to move the leading and remeasure, which is what
    // no text contract can do: `height: var(--h-control-xs)` next to a
    // supporting role reads as pinned whether or not the two resolve to
    // compatible lengths in a live document.
    //
    // "Did not move" and "holds its content" are different claims, and a pin
    // converts the first failure mode into the second. An earlier revision
    // asserted `scrollHeight <= clientHeight` and was inert twice over: it read
    // both values AFTER restoring the leading, and on an `overflow: visible`
    // box the two are equal even while the line box overflows. The tier vs its
    // own floor is the measure that can actually fail — see the helper.
    expectHoldsItsBox(
      await measureUnderLeadingBump(page, '.maka-message-time-inline'),
      '.maka-message-time-inline',
      20, // --h-control-xs; was 20 -> 40 before the pin, and took the meta row with it
    );
  });

  await test.step('code elements resolve the theme mono stack, not the reset one', async () => {
    expect(
      await page.evaluate(() => {
        const probe = document.createElement('code');
        document.body.append(probe);
        const family = getComputedStyle(probe).fontFamily;
        probe.remove();
        return family;
      }),
    ).toContain('Geist Mono');
  });

  await test.step('a role token composes against the element that reads it', async () => {
    // The invariant the role table's second anchor exists for, and the one
    // that reads as obviously true in CSS and is false: var() inside a custom
    // property is substituted where the property is DECLARED, and the resolved
    // string is what inherits. A table composed only on `:root` therefore
    // freezes the sans stack into every role, and a `<pre>` that names a role
    // renders sans however its own --maka-font-family reads. Measured before
    // the second anchor landed, that is exactly what `.maka-tool-diff-body`
    // did. Asserting the CSS text cannot catch it — this has to be a document.
    const composed = await page.evaluate(() => {
      const pre = document.createElement('pre');
      const div = document.createElement('div');
      for (const el of [pre, div]) {
        el.style.font = 'var(--maka-text-supporting)';
        document.body.append(el);
      }
      const read = (el: HTMLElement) => {
        const s = getComputedStyle(el);
        return { family: s.fontFamily, size: s.fontSize, weight: s.fontWeight, leading: s.lineHeight };
      };
      const out = { pre: read(pre), div: read(div) };
      pre.remove();
      div.remove();
      return out;
    });
    // Same role, same three other axes — only the family differs, and only
    // because the element differs. The three non-family axes are pinned to the
    // supporting tier's own values rather than merely to each other: equality
    // alone would also hold if the role stopped resolving entirely and both
    // probes fell back to the same inherited body text.
    expect(composed.pre.family).toContain('Geist Mono');
    expect(composed.div.family).not.toContain('Geist Mono');
    for (const probe of [composed.pre, composed.div]) {
      expect(probe.size).toBe('12px');
      expect(probe.weight).toBe('400');
      // 12 × 1.6667. The ratio is Astryx's reported quotient for a 20px line
      // box at the 12px tier, so the used value lands a fraction over.
      expect(Number.parseFloat(probe.leading)).toBeCloseTo(20, 1);
    }
  });

  await test.step('naming the family axis re-composes the role the element carries', async () => {
    // A <kbd> composes the mono variant of every role. The ⌘N hint in the
    // sidebar has always opted out — it read `font-family: inherit` before the
    // roles landed. The opt-out is now one declaration on the family axis, and
    // it works only because the axis is read on the element itself: this is
    // the same substitution-timing fact as the step above, used deliberately.
    expect(
      await page.evaluate(() => {
        const kbd = document.createElement('kbd');
        kbd.className = 'maka-nav-kbd';
        document.body.append(kbd);
        const family = getComputedStyle(kbd).fontFamily;
        kbd.remove();
        return family;
      }),
    ).not.toContain('Geist Mono');
  });
});

/**
 * #1879, the half of the chip invariant the transcript window cannot show.
 *
 * Two claims that pull in opposite directions, which is why they belong in one
 * test: a single-line chip must NOT move when its leading moves, and a box that
 * wraps MUST still grow with its content. Pinning everything satisfies the
 * first and breaks the second.
 *
 * Both halves assert RELATIVELY. An earlier revision wrote the measured
 * outcome of a viewport squeeze into the assertion — `{height: 42, rows: 2}` at
 * 480px — and CI Linux produced `{height: 20, rows: 1}`: the wrap slack was
 * -4.75px against 244.75px of content, i.e. 1.9%, and the CJK font stack
 * resolves to different families per platform. A wrap threshold is a font
 * metric, not an invariant. So the content is made to wrap by construction and
 * the assertion is "grew", not "grew to N".
 *
 * Reuses the existing fixture rather than adding one, per AGENTS.md. Measured,
 * no booted window renders a chip above `--h-control-xs`:
 * `.maka-composer-model-chip`, `.plan-proposal-step-number`,
 * `.maka-skill-governance-summary span`, `.maka-composer-revision-notice` and
 * `.settingsUsage{DetailToggle,RecordCount}` all resolve to zero nodes in both
 * fixtures, and so do the four chips pinned last — `.maka-quote-chip-collapsed`,
 * `.maka-deep-research-run-count`, `.maka-firstrun-step` and
 * `.maka-mcp-install-button` (measured with a throwaway probe against both
 * booted windows, with `.maka-turn` and `.maka-nav-kbd` as controls).
 *
 * So the floor assertion below proves the MECHANISM (a tier must hold its own
 * content) on three chips whose slack is zero by construction, and not the
 * TIER CHOICE for sm/md/lg. That choice is UNASSERTED, deliberately and
 * stated plainly rather than credited to a check elsewhere: a floor is a live
 * metric — a font's line box, or a 21px child dot — so no text contract can
 * compute it, and each rule records the number it was measured at in its own
 * comment. A padding change that lifts a floor past its tier is caught by
 * reading, not by this suite. Booting those surfaces is a fixture change, not
 * a test change, and it does not belong to this one.
 */
test('pins single-line chips without pinning the boxes that wrap', async ({
  planRemindersWindow: page,
}) => {
  await test.step('every rung of the control ruler resolves to a number', async () => {
    // `--h-control-md/lg/xl` are `var(--size-element-sm/md/lg)`, and those are
    // declared by Astryx's own generated sheet, outside every static scan in
    // this repo (bare imports are skipped by design). If an upgrade renames or
    // drops them, `height: var(--h-control-md)` becomes invalid at
    // computed-value time and falls back to `auto` — #1879 on every md/lg/xl
    // control at once, with nothing in the text contracts able to see it.
    // Nothing else in the suite resolves these to numbers.
    const rungs = await page.evaluate(() => {
      const out: Record<string, number> = {};
      for (const rung of ['xs', 'sm', 'md', 'lg', 'xl', '2xl']) {
        // A FRESH element per rung, and the `var()` written into the
        // declaration rather than resolved in JS first. Reassigning
        // `style.height` on one reused probe reported the first rung's height
        // for every rung — the inline value updated and the computed value did
        // not — so the reuse form measured 20px six times and would have
        // passed a ruler that had collapsed to a single rung.
        const probe = document.createElement('div');
        probe.style.cssText = `position:fixed;top:0;left:0;width:1px;visibility:hidden;height:var(--h-control-${rung});`;
        document.documentElement.append(probe);
        out[rung] = probe.getBoundingClientRect().height;
        probe.remove();
      }
      return out;
    });
    expect(rungs).toEqual({ xs: 20, sm: 24, md: 28, lg: 32, xl: 36, '2xl': 40 });
  });

  await test.step('the pinned chips hold their box against a 40px leading', async () => {
    // Each doubled under this bump before its pin. `.maka-plan-card-countdown`
    // is in none of #1879's lists — it was found by measuring, and it is one of
    // the "12px badges" that issue's scope names: real pill chrome, no height
    // of its own.
    for (const [selector, tier] of [
      ['.maka-nav-kbd', 20],
      ['.maka-plan-card-countdown', 20],
    ] as const) {
      expectHoldsItsBox(await measureUnderLeadingBump(page, selector), selector, tier);
    }
  });

  await test.step('the boxes that wrap still grow with their content', async () => {
    // The guard against over-applying the fix, and the one #1879 would have
    // got wrong: it read `.maka-plan-card-run` as already pinned and offered it
    // as the shape for the rest.
    //
    // The message is the row's LAST child. An earlier revision took
    // `> span` .first(), which is the Astryx Badge — itself a `span` with its
    // own `white-space: nowrap`. Writing a long string into it blew the nowrap
    // flex row out sideways and squeezed the untouched real message to one
    // character per line, which is where that revision's "220px" came from: an
    // artifact that stayed 220px for `.repeat(2)` through `.repeat(12)`.
    const grow = (selector: string, child: string) =>
      page.locator(selector).first().evaluate(
        (el: HTMLElement, sel: string) => {
          const target = el.querySelector(sel) as HTMLElement | null;
          if (!target) return { before: -1, after: -1 };
          const previous = target.textContent;
          const before = el.getBoundingClientRect().height;
          target.textContent = '这是一条很长的运行结果消息用来验证它是否会真的换行'.repeat(4);
          const after = el.getBoundingClientRect().height;
          target.textContent = previous;
          return { before, after };
        },
        child,
      );

    const run = await grow('.maka-plan-card-run', ':scope > span:last-child');
    expect(run.before, 'the run row starts as one line').toBe(20);
    expect(run.after, 'a long run message must not be clipped to one line').toBeGreaterThan(run.before);

    // Same question for the schedule row, constrained at the element rather
    // than by resizing the window: a max-width derived from its own scrollWidth
    // forces a wrap at any font metric, on any platform.
    const schedule = await page.locator('.maka-plan-card-schedule').first().evaluate((el: HTMLElement) => {
      const rowCount = () => new Set([...el.children].map((c) => Math.round(c.getBoundingClientRect().top))).size;
      const before = { height: el.getBoundingClientRect().height, rows: rowCount() };
      el.style.maxWidth = `${Math.ceil(el.scrollWidth / 2)}px`;
      const after = { height: el.getBoundingClientRect().height, rows: rowCount() };
      el.style.removeProperty('max-width');
      return { before, after };
    });
    expect(schedule.before.rows, 'the schedule row starts as one line').toBe(1);
    expect(schedule.after.rows, 'the schedule row must wrap rather than clip').toBeGreaterThan(schedule.before.rows);
    expect(schedule.after.height).toBeGreaterThan(schedule.before.height);
  });
});
