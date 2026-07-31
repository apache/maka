import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the desktop Electron E2E suite.
 *
 * Each test launches a real Electron window backed by the deterministic fake
 * backend (MAKA_E2E=1) against its OWN throwaway userData dir (the fixture
 * mkdtemps one per test), so windows share no state and can run side by side.
 * The suite used to pin `workers: 1` on the theory that parallel windows would
 * fight over the same screen/IPC; with per-test isolation they do not, and the
 * wall clock is dominated by Electron boot — which is exactly what overlaps.
 * Measured on the full 94-test suite: 1 worker ≈ 7min, 4 workers ≈ 2.4min.
 *
 * CI stays at 2 to leave headroom on a shared runner (a saturated host shows
 * up as timeout flake, and this suite deliberately keeps `retries: 0`).
 *
 * Run from apps/desktop via `npm run e2e`, which builds the app first.
 */
export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
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
