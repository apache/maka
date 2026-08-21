import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the desktop Electron E2E suite.
 *
 * Each test launches a real Electron window backed by the deterministic fake
 * backend (MAKA_E2E=1) against its OWN throwaway userData dir (the fixture
 * mkdtemps one per test), so windows share no *state*. A Runtime Host-backed
 * window owns both Electron and an execution candidate process. Keep the
 * default at one worker: concurrent hidden windows throttle animation frames
 * and share OS focus, invalidating geometry and focus contracts. Developers
 * can still pass `--workers` explicitly for a subset that has neither concern.
 * Deliberately no test count here — the previous note carried a stale one that
 * outlived two rounds of pruning. `playwright test --list` is the only figure
 * that cannot rot.
 *
 * Linux CI uses an isolated X display; macOS CI shows the window so App Nap
 * cannot throttle the compositor. Local parallelism is still opt-in.
 *
 * Run from apps/desktop via `npm run e2e`, which builds the app first.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  workers: 1,
  // CI publishes no Playwright report that consumes Git metadata. Disable its
  // best-effort shallow-history fetch, which otherwise waits on a fixed timeout.
  captureGitInfo: { commit: false, diff: false },
  // No retries: flakes should fail loudly. The fixture waits for the composer
  // to mount (the cold-start convergence point — connection seed, onboarding
  // clear, renderer hydrated), so cold-start variance never reaches the test.
  retries: 0,
  // Keep enough room for the 60-second first-window bound plus the fixture's
  // readiness assertion. Runtime Host election remains independently capped.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
