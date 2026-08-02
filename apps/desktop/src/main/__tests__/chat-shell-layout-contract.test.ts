/**
 * Chat / workspace chrome layout contracts demoted from Electron e2e.
 *
 * These outcomes used to be measured with getBoundingClientRect after a cold
 * start. The load-bearing fixes are pure CSS or source structure: pin them
 * here with rule-scoped helpers (not cross-`}` regex). Keep content-visibility
 * pin/warm-up and focus restoration in e2e.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  REPO_ROOT,
  stripCssComments,
  assertCssRuleDecls,
  cssMediaBody,
  cssRuleBody,
} from './css-test-helpers.js';

const STYLES = resolve(REPO_ROOT, 'apps/desktop/src/renderer/styles');
const CHROME_ACTIONS = resolve(
  REPO_ROOT,
  'apps/desktop/src/renderer/app-shell-chrome-actions.tsx',
);

async function readCss(name: string): Promise<string> {
  return stripCssComments(await readFile(resolve(STYLES, name), 'utf8'));
}

describe('chat shell layout contracts', () => {
  /**
   * #1897 / #1910. The mode marks' entire visual contract lives in this one
   * rule, and nothing else can see it: the `@maka/ui` SSR tests never load a
   * stylesheet, and dead-CSS only asks whether the class is referenced. Delete
   * the rule and an ON mode becomes indistinguishable from the inert ＋ beside
   * it, with every other check still green — so pin the rule here.
   *
   * `background-color`, not `background`: composer.css is in the last cascade
   * layer, so the shorthand's implicit `background-image: none` would beat the
   * ghost button's own :hover / :active overlays from `astryx-components` and
   * strip all pointer feedback from the one control that leaves a mode. The
   * voice button carries the same pair for the same reason.
   */
  it('draws active-mode and voice marks in one accent without killing ghost feedback', async () => {
    const css = await readCss('composer.css');
    assertCssRuleDecls(
      css,
      '.maka-composer-mode-button',
      [
        /color:\s*var\(--accent\)/,
        /background-color:\s*color-mix\([^;]*currentColor/,
      ],
      'every mode mark draws in the single product accent over a currentColor wash',
    );
    for (const selector of [
      '.maka-composer-mode-button',
      '.maka-composer-voice-button[data-state="recording"]',
      '.maka-composer-voice-button[data-state="native_ready"]',
    ]) {
      const body = cssRuleBody(css, selector);
      assert.ok(body != null, `${selector} must exist`);
      assert.doesNotMatch(
        body!,
        /(^|[;{]\s*)background\s*:/,
        `${selector} must not use the background shorthand — it suppresses the ghost hover overlay`,
      );
    }
  });

  it('keeps ChatLayout flex contracts that kill the phantom dock range', async () => {
    const css = await readCss('chat-header.css');
    assertCssRuleDecls(
      css,
      '.maka-chat-layout',
      [/display:\s*flex/, /flex-direction:\s*column/, /min-height:\s*0/],
      'chat layout must be a column flex host with min-height 0',
    );
    assertCssRuleDecls(
      css,
      '.maka-chat-layout > :first-child',
      [/min-height:\s*0/, /flex:\s*1\s+0\s+auto/],
      'message area must flex without a 100% min-height phantom',
    );
    assertCssRuleDecls(
      css,
      '.maka-chat-layout > :last-child',
      [/flex-shrink:\s*0/],
      'composer/dock row must not shrink under the message area',
    );
  });

  it('keeps the project catalog as the only scroll region in the workspace menu', async () => {
    const css = await readCss('composer.css');
    assertCssRuleDecls(
      css,
      '.maka-composer-project-scroll',
      [/max-height:\s*224px/, /overflow-y:\s*auto/],
      'project list must scroll inside a capped region',
    );
  });

  it('caps the narrow session workbar so it cannot own the viewport', async () => {
    const css = await readCss('chat-detail.css');
    const media = cssMediaBody(css, '(max-width: 990px)');
    assert.ok(media, 'narrow workbar media query must exist');
    assertCssRuleDecls(
      media!,
      '.maka-session-workbar',
      [/max-height:\s*min\(\s*42dvh\s*,\s*360px\s*\)/],
      'narrow workbar must stay under 42dvh',
    );
  });

  it('keeps model picker marks square and labels ellipsized', async () => {
    const css = await readCss('model-switcher.css');
    assertCssRuleDecls(
      css,
      '.modelPickerProviderMark',
      [/width:\s*1rem/, /height:\s*1rem/, /flex:\s*0\s+0\s+1rem/],
      'provider marks must be a fixed 1rem square',
    );
    assertCssRuleDecls(
      css,
      '.modelPickerOptionLabel',
      [/overflow:\s*hidden/, /text-overflow:\s*ellipsis/, /white-space:\s*nowrap/],
      'long model labels must ellipsize',
    );
  });

  it('keeps bot onboarding QR frames square and image-filling', async () => {
    const css = await readCss('settings/bot.css');
    assertCssRuleDecls(
      css,
      '.settingsBotOnboardingQrFrame',
      [/width:\s*284px/, /height:\s*284px/, /place-items:\s*center/],
      'QR frame must be a fixed square',
    );
    assertCssRuleDecls(
      css,
      '.settingsBotOnboardingQrFrame img',
      [/width:\s*100%/, /height:\s*100%/, /object-fit:\s*contain/],
      'QR image must fill its frame',
    );
  });

  it('folds workspace secondary actions into one overflow menu in source', async () => {
    const source = await readFile(CHROME_ACTIONS, 'utf8');
    assert.match(
      source,
      /export function AppShellWorkspaceTopActions/,
      'workspace top actions component must exist',
    );
    assert.match(source, /copy\.moreActions/, 'overflow trigger must be the more-actions control');
    // Wiring, not just copy strings: empty onClick would still pass a name scan.
    assert.match(
      source,
      /onClick=\{\(\)\s*=>\s*scheduleAfterMenuClose\(props\.onOpenFeedback\)\}/,
      'feedback menu item must schedule onOpenFeedback',
    );
    assert.match(
      source,
      /onClick=\{\(\)\s*=>\s*scheduleAfterMenuClose\(props\.onOpenPalette\)\}/,
      'command palette menu item must schedule onOpenPalette',
    );
    assert.match(
      source,
      /onClick=\{\(\)\s*=>\s*scheduleAfterMenuClose\(props\.onOpenHelp\)\}/,
      'help menu item must schedule onOpenHelp',
    );
    assert.match(
      source,
      /onClick=\{\(\)\s*=>\s*scheduleAfterMenuClose\(props\.onOpenHealth\)\}/,
      'health menu item must schedule onOpenHealth',
    );
    // Secondary actions only enter the menu, never as sibling IconButtons.
    assert.doesNotMatch(
      source,
      /AppShellWorkspaceTopActions[\s\S]*?onOpenFeedback[\s\S]*?<IconButton[\s\S]*?onOpenFeedback/,
      'feedback must not be a resident IconButton',
    );
    assert.match(
      source,
      /workbarAvailable\s*&&\s*\([\s\S]*?<IconButton[\s\S]*?workbarLabel/,
      'workbar toggle mounts only when a session workbar is available',
    );
    // Exactly one DropdownMenu in the workspace toolbar path.
    const menuCount = (source.match(/<DropdownMenu\b/g) ?? []).length;
    assert.equal(menuCount, 1, 'workspace actions must use one overflow DropdownMenu');
  });
});
