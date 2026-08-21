#!/usr/bin/env node
/**
 * Desktop E2E candidate entry. It exists so the production entry
 * (`execution-candidate-main.ts`) carries no import of the E2E composition and
 * no `--desktop-e2e` branch: the entry file IS the switch, which is what keeps
 * FakeBackend and this bootstrap out of the release artifacts.
 *
 * The E2E run still goes through the real Runtime Host composition — only the
 * `primaryBackendFactory` seam is substituted.
 */
import { runExecutionCandidateEntry } from '../candidate-entry.js';
import {
  createDesktopE2eExecutionCandidateDependencies,
  DESKTOP_E2E_IDLE_GRACE_MS,
  watchDesktopE2eParentProcess,
} from './desktop-e2e-execution.js';

await runExecutionCandidateEntry(process.argv.slice(2), {
  overrideOptions: (options) => ({ ...options, idleGraceMs: DESKTOP_E2E_IDLE_GRACE_MS }),
  dependencies: createDesktopE2eExecutionCandidateDependencies(),
  onWon: (host) => watchDesktopE2eParentProcess(() => host.close()),
});
