import { createHash } from 'node:crypto';

export const HARBOR_ORACLE_VERSION = '0.13.2';
export const HARBOR_ORACLE_DOCKER_PLATFORM = 'linux/amd64';
export const HARBOR_ORACLE_EXECUTION_POLICY = {
  schemaVersion: 1,
  harborVersion: HARBOR_ORACLE_VERSION,
  environment: {
    type: 'docker',
    platform: HARBOR_ORACLE_DOCKER_PLATFORM,
    composeFile: 'docker-compose-linux-amd64.yaml',
    forceBuild: false,
    delete: true,
  },
  job: {
    agent: 'oracle',
    attempts: 1,
    concurrentTrials: 1,
    timeoutMultiplier: 1,
  },
  verifier: {
    importPath: 'maka_verifier:MakaVerifier',
    maxAttempts: 3,
    defaultAttemptTimeoutSec: 600,
    totalAttemptBudgetMultiplier: 2,
    retryBackoffSec: 2,
    retryGraceSec: 120,
    timeoutPolicy: 'candidate_timeout_without_replay',
  },
  watchdog: {
    minimumSec: 45 * 60,
    setupTeardownGraceSec: 15 * 60,
    calculation: 'max(minimum,native-phases-plus-setup-teardown-grace)',
  },
  resultInterpretation: 'structured-verifier-outcome-and-reward-agreement-v1',
} as const;
export const HARBOR_ORACLE_MAX_ATTEMPTS = HARBOR_ORACLE_EXECUTION_POLICY.verifier.maxAttempts;

export function resolveHarnessOracleWatchdogTimeoutMs(input: {
  agentTimeoutSec: number;
  verifierTimeoutSec: number;
}): number {
  const nativePhasesSec =
    (input.agentTimeoutSec + input.verifierTimeoutSec) *
    HARBOR_ORACLE_EXECUTION_POLICY.job.timeoutMultiplier;
  return (
    Math.max(
      HARBOR_ORACLE_EXECUTION_POLICY.watchdog.minimumSec,
      nativePhasesSec + HARBOR_ORACLE_EXECUTION_POLICY.watchdog.setupTeardownGraceSec,
    ) * 1_000
  );
}

export interface HarnessOracleTaskResult {
  outcome: 'passed' | 'failed' | 'candidate_timeout';
  reward: number;
  attempts: number;
}

export function buildHarnessOracleExecutionPolicyFingerprint(input: {
  verifierImplementationSource: string | Uint8Array;
  composeImplementationSource: string | Uint8Array;
}): string {
  return fingerprintValue({
    policy: HARBOR_ORACLE_EXECUTION_POLICY,
    verifierImplementationFingerprint: fingerprintBytes(input.verifierImplementationSource),
    composeImplementationFingerprint: fingerprintBytes(input.composeImplementationSource),
  });
}

function fingerprintBytes(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fingerprintValue(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
