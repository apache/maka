#!/usr/bin/env node
import { FakeBackend } from '@maka/runtime';
import { parseRuntimeHostCandidateArguments } from './candidate-cli.js';
import { startExecutionRuntimeHostCandidate } from './server/execution-candidate.js';
import { createExecutionRuntimeHostComposition } from './server/execution-composition.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';

const options = parseRuntimeHostCandidateArguments(process.argv.slice(2));
const result = await startExecutionRuntimeHostCandidate(options, {
  createComposition: (context, compositionOptions) =>
    createExecutionRuntimeHostComposition(context, compositionOptions, {
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
    }),
});
if (result.kind === 'loser') process.exit(2);

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
}
