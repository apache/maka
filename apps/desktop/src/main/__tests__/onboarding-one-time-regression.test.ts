/**
 * Regression tests for the onboarding one-time fix (PR #466).
 *
 * Three behavioral gates locked by source-level assertions because the
 * renderer action factory (`createAppShellSessionStartActions`) and the
 * hero component run in the renderer process — no DOM/React test
 * runtime exists in the main-side `node --test` harness.
 *
 * Gates:
 *  1. `setMilestone` failure must not block a successful session start.
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

// #1433: this used to key off `if (result.ok)` — the shape of the deleted
// `quickChat:start` union. `startModeSession`, the action that replaced quick
// chat, has no `result.ok` at all, so that single loose regex silently drifted
// onto `handleExpertTeamStart` and stopped guarding the path it was written
// for. Both surviving entry points hold the invariant; name each one.
const MILESTONE_ENTRY_POINTS = [
  {
    fn: 'startModeSession',
    successPath: /const session = await window\.maka\.sessions\.create\([\s\S]*?return true;/,
  },
  { fn: 'handleExpertTeamStart', successPath: /if \(result\.ok\) \{[\s\S]*?return true;/ },
] as const;

describe('onboarding one-time regression — session-start milestone best-effort', () => {
  for (const entry of MILESTONE_ENTRY_POINTS) {
    it(`${entry.fn} sets the milestone AFTER openSessionInChat, fire-and-forget`, () => {
      const src = readRenderer('app-shell-session-start-actions.ts');
      const branch = src.match(entry.successPath)?.[0] ?? '';
      assert.ok(branch, `must find the success path of ${entry.fn}`);

      const openIdx = branch.indexOf('openSessionInChat');
      const milestoneIdx = branch.indexOf('setMilestone');
      assert.ok(openIdx >= 0, `${entry.fn} must call openSessionInChat on success`);
      assert.ok(milestoneIdx >= 0, `${entry.fn} must call setMilestone on success`);
      assert.ok(
        openIdx < milestoneIdx,
        'openSessionInChat must run BEFORE setMilestone so milestone failure does not block the chat',
      );

      assert.match(
        branch,
        /void\s+window\.maka\.onboarding\.setMilestone\([^)]+\)\.catch\(\(\)\s*=>\s*\{\}\)/,
        'setMilestone must be void + .catch(() => {}) so it cannot reject into the outer catch',
      );
    });
  }
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
