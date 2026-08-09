#!/usr/bin/env node
import { FakeBackend } from '@maka/runtime';
import { parseRuntimeHostCandidateArguments } from './candidate-cli.js';
import { startExecutionRuntimeHostCandidate } from './server/execution-candidate.js';
import { createExecutionRuntimeHostComposition } from './server/execution-composition.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';
import { installRuntimeHostLogCapture } from './process-diagnostics.js';

installRuntimeHostLogCapture();

const options = parseRuntimeHostCandidateArguments(process.argv.slice(2));
const result = await startExecutionRuntimeHostCandidate(
  {
    ...options,
    // Every desktop E2E fixture owns a fresh workspace and can never reconnect
    // to this candidate. Preserve enough time for the election retry, then let
    // teardown converge without production's multi-client restart grace.
    idleGraceMs: 500,
  },
  {
    createComposition: (context, compositionOptions) =>
      createExecutionRuntimeHostComposition(
        context,
        {
          ...compositionOptions,
          bootstrapRuntimePolicy: false,
        },
        {
          primaryBackendFactory: (backendContext) => new FakeBackend(backendContext),
          oauthAuthorization: {
            startCodexAuthorization: async () => ({
              deviceAuthId: 'desktop-e2e-device-authorization',
              userCode: 'MAKA-E2E',
              verificationUrl: 'https://auth.openai.com/codex/device',
              expiresAt: Date.now() + 60_000,
              intervalMs: 1,
            }),
            pollCodexAuthorization: async () => ({
              authorizationCode: 'desktop-e2e-authorization-code',
              codeVerifier: 'desktop-e2e-code-verifier',
            }),
            exchangeCodexCode: async () => ({
              access_token: 'desktop-e2e-access-token',
              refresh_token: 'desktop-e2e-refresh-token',
              expires_at: Date.now() + 3_600_000,
            }),
          },
        },
      ),
  },
);
if (result.kind === 'loser') process.exit(2);

const desktopParentPid = process.ppid;
const parentWatch = setInterval(() => {
  if (process.ppid === desktopParentPid && isProcessAlive(desktopParentPid)) return;
  clearInterval(parentWatch);
  void result.host.close().catch(() => {
    process.exitCode = 1;
  });
}, 100);
parentWatch.unref();

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
} finally {
  clearInterval(parentWatch);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
