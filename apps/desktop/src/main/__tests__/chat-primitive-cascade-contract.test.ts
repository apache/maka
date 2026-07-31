import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, readAllRendererCss, stripCssComments } from './css-test-helpers.js';

/**
 * Zero-visual governance contract for issue #332 PR1 — the chat
 * conversation-flow row/bubble *shell* moved onto the `@maka/ui` `Message` /
 * `Bubble` primitives. These assertions lock the two halves of "zero visual
 * change": the bespoke shell CSS is retired while turn machinery keeps its
 * layout. Astryx owns Markdown prose separately.
 */
describe('chat primitive shell migration contract (#332 PR1)', () => {
  it('retires the bespoke bubble/row shell selectors', async () => {
    const css = stripCssComments(await readAllRendererCss());
    for (const selector of [
      '.maka-bubble-user',
      '.maka-bubble-truncated',
      '.maka-bubble-assistant-stack',
      '.message.user',
      '.message.assistant',
      '.message.system',
      '.message >',
      '.message pre',
    ]) {
      assert.ok(
        !css.includes(selector),
        `retired shell selector "${selector}" still present in renderer CSS`,
      );
    }
  });

  it('leaves Markdown prose to Astryx instead of retaining the legacy prose class', async () => {
    const css = await readAllRendererCss();
    const chat = await readFile(
      resolve(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'chat.tsx'),
      'utf8',
    );
    assert.ok(css.includes('.maka-bubble-assistant {'));
    assert.doesNotMatch(`${css}\n${chat}`, /\.maka-prose\b|maka-prose/);
  });

  it('keeps the row + re-anchors turn layout onto the Message primitive', async () => {
    const css = await readAllRendererCss();
    // The centered reading column / entrance animation stay authored.
    assert.ok(css.includes('.maka-message-row'), '.maka-message-row row base must stay');
    // The turn lineage row + footer measure column that PR1 parked on this
    // primitive's data hook migrated onto the `@maka/ui` Marker variants in PR2
    // (chat-marker-cascade-contract.test.ts), so the re-anchor is gone now.
    // The system-note `pre` re-anchor stays — that prose is still hand-written.
    assert.ok(css.includes('[data-slot="message"][data-role="system"] pre:not(.astryx-codeblock)'));
  });

  it('pins the user bubble shell to the retired .maka-bubble-user pixels', async () => {
    const rawSrc = await readFile(
      resolve(REPO_ROOT, 'packages', 'ui', 'src', 'primitives', 'chat.tsx'),
      'utf8',
    );
    // Strip comments so the assertions reflect real classNames, not prose that
    // happens to name the scale utilities it is telling us to avoid.
    const chatSrc = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // The shell values are LITERAL Tailwind arbitrary utilities, so the variant
    // class string compiles 1:1 to its declarations on a leaf element with
    // nothing to resolve or override — asserting the exact string here is
    // equivalent to asserting the computed style, without a browser. Matching
    // the WHOLE string (not just "contains each literal") also pins the set
    // closed: a stray extra `rounded-[12px]` / `px-4` / second `max-w-*` that
    // would silently override the shell makes this fail. Values mirror the
    // retired `.maka-bubble-user` (padding 10px 14px; line-height 1.5 via
    // --leading-normal per #546 PR0; max-width min(100%,640px); --chat-user-bg)
    // with radius now on the
    // `--radius-surface` token per #406 gap 4. Padding snapped 14→12 per
    // the --space-* scale (#430 PR3): px-3 (12px) py-2.5 (10px).
    const bubbleBlock = chatSrc.slice(chatSrc.indexOf('bubbleVariants'));
    const userClass = bubbleBlock.match(/user:\s*"([^"]*)"/)?.[1];
    assert.equal(
      userClass,
      'max-w-[min(100%,640px)] whitespace-pre-wrap break-words rounded-[var(--radius-surface)] bg-[var(--chat-user-bg)] px-3 py-2.5 leading-normal text-[color:var(--chat-user-foreground,var(--foreground))]',
      'user bubble variant must match the retired .maka-bubble-user geometry (radius on --radius-surface token, padding on --space-* scale, line-height on --leading-normal per #546 PR0)',
    );
  });
});
