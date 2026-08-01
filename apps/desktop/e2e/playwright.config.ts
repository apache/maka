import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the desktop Electron E2E suite.
 *
 * Each test launches a real Electron window backed by the deterministic fake
 * backend (MAKA_E2E=1) against its OWN throwaway userData dir (the fixture
 * mkdtemps one per test), so windows share no *state*. The wall clock is
 * dominated by Electron boot, which overlaps well: a past full-suite run
 * measured 1 worker ≈ 7min against 4 workers ≈ 2.4min. Deliberately no test
 * count here — the previous note carried a stale one that outlived two rounds
 * of pruning. `playwright test --list` is the only figure that cannot rot.
 *
 * What parallel windows DO share is OS focus. A run at 2 workers showed it:
 * composer-mode-indicator compares hover backgrounds and plan-reminders
 * asserts `toBeFocused()`, and both fail when another window steals activation
 * mid-assertion — Chromium blurs the document when its window deactivates.
 *
 * So CI stays at 1 until those two specs are hardened (bring the window to
 * front before asserting hover/focus, or assert without needing activation).
 * Local runs take the parallel win now, where the dev loop feels it most; a
 * local hover/focus failure is reproducible by re-running that spec alone.
 *
 * Run from apps/desktop via `npm run e2e`, which builds the app first.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  workers: process.env.CI ? 1 : 4,
  // No retries: flakes should fail loudly. The fixture waits for the composer
  // to mount (the cold-start convergence point — connection seed, onboarding
  // clear, renderer hydrated), so cold-start variance never reaches the test.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
