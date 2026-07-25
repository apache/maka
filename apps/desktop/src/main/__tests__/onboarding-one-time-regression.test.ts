/**
 * Regression tests for the onboarding one-time fix (PR #466).
 *
 * Three behavioral gates locked by source-level assertions because the
 * renderer action factory (`createAppShellSessionStartActions`) and the
 * hero component run in the renderer process — no DOM/React test
 * runtime exists in the main-side `node --test` harness.
 *
 * Gates:
 *  1. `setMilestone` failure must not block a successful quick chat.
 *  2. `showOnboardingHero` must include `sessions.length === 0`.
 *  3. `SkipButton` must restore pending + the `onSkip` caller must
 *     catch + toast on failure.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/main/__tests__/ → src/renderer/
const rendererRoot = join(__dirname, '..', '..', '..', 'src', 'renderer');

function readRenderer(relativePath: string): string {
  return readFileSync(join(rendererRoot, relativePath), 'utf8');
}

describe('onboarding one-time regression — quick chat milestone best-effort', () => {
  it('setMilestone is called AFTER openSessionInChat and is fire-and-forget with catch', () => {
    const src = readRenderer('app-shell-session-start-actions.ts');
    const okBranch = src.match(/if \(result\.ok\) \{[\s\S]*?return true;/)?.[0] ?? '';
    assert.ok(okBranch, 'must find result.ok branch');

    // openSessionInChat must appear before setMilestone in the ok branch.
    const openIdx = okBranch.indexOf('openSessionInChat');
    const milestoneIdx = okBranch.indexOf('setMilestone');
    assert.ok(openIdx >= 0, 'must call openSessionInChat in ok branch');
    assert.ok(milestoneIdx >= 0, 'must call setMilestone in ok branch');
    assert.ok(
      openIdx < milestoneIdx,
      'openSessionInChat must run BEFORE setMilestone so milestone failure does not block the chat',
    );

    // setMilestone must be fire-and-forget (void + .catch).
    assert.match(
      okBranch,
      /void\s+window\.maka\.onboarding\.setMilestone\([^)]+\)\.catch\(\(\)\s*=>\s*\{\}\)/,
      'setMilestone must be void + .catch(() => {}) so it cannot reject into the outer catch',
    );
  });
});

describe('onboarding one-time regression — showOnboardingHero sessions gate', () => {
  it('showOnboardingHero includes sessions.length === 0 hard gate', () => {
    const src = readRenderer('app-shell.tsx');
    const match = src.match(/const showOnboardingHero\s*=\s*([\s\S]*?);/);
    assert.ok(match, 'must find showOnboardingHero declaration');
    const expr = match[1];
    assert.match(
      expr,
      /sessions\.length\s*===\s*0/,
      'showOnboardingHero must include sessions.length === 0 to prevent hero overlaying existing sessions',
    );
    assert.match(
      expr,
      /!onboardingSettled/,
      'showOnboardingHero must include !onboardingSettled milestone gate',
    );
  });
});

describe('onboarding one-time regression — SkipButton error recovery', () => {
  it('SkipButton restores pending in finally and awaits onSkip', () => {
    const src = readRenderer('OnboardingHero.tsx');
    const skipButtonMatch = src.match(/function SkipButton[\s\S]*?\n}/);
    assert.ok(skipButtonMatch, 'must find SkipButton function');
    const skipButton = skipButtonMatch[0];

    // Must await onSkip so pending/loading works.
    assert.match(skipButton, /await props\.onSkip\(\)/, 'must await props.onSkip()');

    // Must restore pending in finally so the button recovers on failure.
    assert.match(
      skipButton,
      /finally\s*\{[\s\S]*setPending\(false\)/,
      'must restore pending=false in finally block',
    );
  });

  it('app-shell onSkip catches and toasts on failure', () => {
    const src = readRenderer('app-shell.tsx');
    const onSkipMatch = src.match(/onSkip=\{async \(\) => \{[\s\S]*?\}\}/);
    assert.ok(onSkipMatch, 'must find onSkip handler in app-shell');
    const onSkip = onSkipMatch[0];

    assert.match(onSkip, /try\s*\{/, 'onSkip must have try block');
    assert.match(onSkip, /catch\s*\(/, 'onSkip must have catch block');
    assert.match(onSkip, /toastApi\.error\([\s\S]*shellCopy\.skipErrorTitle/);
    assert.match(onSkip, /localizedShellErrorMessage\(error, shellCopy\.tryAgainLater, uiLocale\)/);
  });
});
