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
 * What parallel windows DO share is OS focus. Specs that assert
 * `toBeFocused()` (e.g. plan-reminders) fail when another window steals
 * activation mid-assertion — Chromium blurs the document when its window
 * deactivates. Each CI shard therefore keeps one worker on an isolated X
 * display; local runs take the parallel win, and a local focus failure re-runs
 * alone to confirm.
 *
 * Run from apps/desktop via `npm run e2e`, which builds the app first.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  workers: process.env.CI ? 1 : 4,
  // CI publishes no Playwright report that consumes Git metadata. Disable its
  // best-effort shallow-history fetch, which otherwise waits on a fixed timeout.
  captureGitInfo: { commit: false, diff: false },
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
