import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { decodeJsonObject, type ExperimentCell, type JsonObject } from './experiment.js';
import {
  BUNDLED_HARNESS_RELAY_ROOT,
  createHarnessPreparationEnvironment,
  resolveRealPathWithinRoot,
} from './harness-environment.js';
import {
  preflightHarnessInstallation,
  type HarnessPreflightDependencies,
} from './install-preflight.js';
import {
  MAKA_RUNTIME_ARTIFACT_PATH,
  MAKA_SUBJECT_STDERR_PATH,
  MAKA_SUBJECT_STDOUT_PATH,
} from './maka-artifacts.js';
import {
  type ExecutorAttemptOutcome,
  type ExperimentExecutor,
  type ExecutorPreparationCode,
  type ExecutorVerification,
  type SubjectExecutionContext,
} from './runner.js';
import type { EvalResult } from './result.js';

export type HarnessFramework = 'harbor' | 'pier';
type RelayTransportStage = 'ready' | 'execute' | 'receive' | 'decision';

const PIER_FRAMEWORK_LOG_MOUNTS = Object.freeze([
  { directory: 'agent', target: '/logs/agent' },
  { directory: 'verifier', target: '/logs/verifier' },
  { directory: 'artifacts', target: '/logs/artifacts' },
]);

interface RelayTransportFailure {
  readonly stage: RelayTransportStage;
  readonly category:
    | 'broken-pipe'
    | 'connection-reset'
    | 'peer-closed'
    | 'protocol-error'
    | 'transport-error';
  readonly delivery: 'not-delivered' | 'unknown';
}

interface RelayTransport {
  readonly socket: Socket;
  stage: RelayTransportStage;
  failure?: RelayTransportFailure;
}

interface RelayState {
  readonly child: ChildProcess;
  readonly transport: RelayTransport;
  readonly closeRelay: () => Promise<void>;
  readonly lines: AsyncIterator<string>;
  readonly token: string;
  readonly trialName: string;
  readonly trialPath: string;
  readonly taskInput: string;
  readonly credentials: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly executionEnvironment: Readonly<Record<string, string>>;
  used: boolean;
  diagnostic?: SubjectProcessDiagnostic;
}

type SubjectProcessDiagnostic = NonNullable<
  Awaited<ReturnType<SubjectExecutionContext['execute']>>['diagnostic']
>;

export interface HarnessExecutor extends ExperimentExecutor {
  preflight(
    input: {
      readonly subjectCredentialNames: readonly string[];
      readonly signal?: AbortSignal;
    },
    dependencies?: Partial<HarnessPreflightDependencies>,
  ): Promise<void>;
}

export function createHarborExecutor(config: JsonObject, specPath: string): HarnessExecutor {
  return createHarnessExecutor('harbor', config, specPath);
}

export function createPierExecutor(config: JsonObject, specPath: string): HarnessExecutor {
  return createHarnessExecutor('pier', config, specPath);
}

function createHarnessExecutor(
  framework: HarnessFramework,
  config: JsonObject,
  specPath: string,
): HarnessExecutor {
  const options = decodeHarnessOptions(config, framework);
  const executor: HarnessExecutor = {
    kind: framework,
    preflight: (input, dependencies) =>
      preflightHarnessInstallation(
        {
          framework,
          options,
          specPath,
          subjectCredentialNames: input.subjectCredentialNames,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        dependencies,
      ),
    validate: (cell) => {
      decodeTask(framework, options, cell);
    },
    runAttempt: (input, operation) =>
      runHarnessAttempt(framework, options, specPath, input, operation),
  };
  return executor;
}

async function runHarnessAttempt(
  framework: HarnessFramework,
  options: HarnessOptions,
  specPath: string,
  {
    cell,
    subjectCredentialNames,
    signal,
  }: {
    readonly cell: ExperimentCell;
    readonly subjectCredentialNames: readonly string[];
    readonly signal?: AbortSignal;
  },
  operation: (attempt: {
    readonly context: SubjectExecutionContext;
    verify(): Promise<ExecutorVerification>;
  }) => Promise<EvalResult>,
): Promise<ExecutorAttemptOutcome> {
  if (signal?.aborted) return notStarted('cancelled');
  let prepared: Awaited<ReturnType<typeof startTrial>>;
  try {
    prepared = await startTrial(framework, options, specPath, cell, subjectCredentialNames, signal);
  } catch {
    return notStarted('preparation-failed');
  }
  if (prepared.kind === 'not_started') return prepared;
  const state = prepared.state;
  let decision = false;
  let value: EvalResult | undefined;
  let hasValue = false;
  let hostCancellationObserved = false;
  let verificationConfirmedBeforeCancellation = false;
  let finalizationEvidence: TrialWaitEvidence | undefined;
  let cleanupAction: 'abort' | 'terminate-unused' | undefined;
  let cleanupEvidence: TrialWaitEvidence | undefined;
  let cleanup: Promise<TrialWaitEvidence> | undefined;
  const terminate = () => {
    cleanupAction ??= state.used ? 'abort' : 'terminate-unused';
    cleanup ??= (async () => {
      const evidence = await waitForTrial(state.child, {
        phase: state.used ? 'abort' : 'unused',
        deadlineMs: state.used ? RELAY_SETTLEMENT_DEADLINE_MS : TERM_SETTLEMENT_DEADLINE_MS,
      });
      if (evidence.outcome === 'unsettled') await state.closeRelay();
      return evidence;
    })();
    return cleanup;
  };
  const onAbort = () => {
    hostCancellationObserved = true;
    void terminate();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const decide = () => {
    if (decision) return true;
    if (
      !sendRelayMessage(state.transport, 'decision', { token: state.token, kind: 'verify' }, true)
    ) {
      void terminate();
      return false;
    }
    decision = true;
    return true;
  };
  try {
    value = await operation({
      context: relayContext(state, signal),
      verify: async () => {
        if (!decide()) {
          cleanupEvidence = await terminate();
          finalizationEvidence = cleanupEvidence;
          throw new Error('relay verify decision was not delivered');
        }
        const completed = cleanup
          ? await cleanup
          : await waitForTrial(state.child, { phase: 'completion' });
        finalizationEvidence = completed;
        if (!finalizationConfirmed(completed)) throw new Error('Trial did not finalize cleanly');
        const verification = await readVerification(
          state,
          cell,
          framework,
          Boolean(options.egressProxy),
        );
        verificationConfirmedBeforeCancellation = !hostCancellationObserved;
        return verification;
      },
    });
    hasValue = true;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!decision || cleanup) {
      cleanupEvidence = await terminate();
      finalizationEvidence = cleanupEvidence;
    }
    await state.closeRelay();
  }
  if (
    hasValue &&
    (state.transport.failure || cleanupAction || state.diagnostic?.category !== 'none')
  ) {
    value = {
      ...value!,
      artifacts: [
        ...value!.artifacts,
        ...(state.transport.failure
          ? [{ kind: 'executor-relay', ...state.transport.failure }]
          : []),
        ...(cleanupAction
          ? [
              {
                kind: 'executor-cleanup',
                action: cleanupAction,
                phase: cleanupEvidence!.phase,
                deadlineMs: cleanupEvidence!.deadlineMs,
                escalation: cleanupEvidence!.escalation,
                outcome: cleanupEvidence!.outcome,
              },
            ]
          : []),
        ...(state.diagnostic && state.diagnostic.category !== 'none'
          ? [{ kind: 'executor-relay-result', ...state.diagnostic }]
          : []),
      ],
    };
  }
  if (hostCancellationObserved && !verificationConfirmedBeforeCancellation) {
    return hasValue
      ? { kind: 'indeterminate', cause: 'host-cancelled', value }
      : { kind: 'indeterminate', cause: 'host-cancelled' };
  }
  if (!finalizationEvidence || !finalizationConfirmed(finalizationEvidence)) {
    return hasValue
      ? { kind: 'indeterminate', cause: 'cleanup-unconfirmed', value }
      : { kind: 'indeterminate', cause: 'cleanup-unconfirmed' };
  }
  if (!hasValue) throw new Error('executor operation did not settle');
  return { kind: 'settled', value };
}

function relayContext(state: RelayState, signal?: AbortSignal): SubjectExecutionContext {
  const resultToken = randomBytes(16).toString('hex');
  const metadata: JsonObject = {
    trialName: state.trialName,
    trialPath: state.trialPath,
    meteringSecret: resultToken,
  };
  return {
    cwd: state.cwd,
    taskInput: state.taskInput,
    metadata,
    ...(signal ? { signal } : {}),
    execute: async (input) => {
      signal?.throwIfAborted();
      if (state.used) throw new Error('Trial already executed its subject');
      state.used = true;
      const credentials = Object.fromEntries(
        Object.entries(input.credentialEnvironment).map(([target, source]) => {
          const value = state.credentials[source];
          if (value === undefined) throw new Error(`credential ${source} was not admitted`);
          return [target, value];
        }),
      );
      if (
        !sendRelayMessage(state.transport, 'execute', {
          token: state.token,
          kind: 'execute',
          command: input.command,
          args: input.args,
          environment: mergeExecutionEnvironment(
            state.executionEnvironment,
            input.environment ?? {},
          ),
          credentials,
          resultToken,
          captureStdout: input.captureStdout ?? true,
        })
      ) {
        throw new Error('relay transport is unavailable');
      }
      state.transport.stage = 'receive';
      let executed: Record<string, unknown>;
      try {
        executed = await readLine(state.lines);
      } catch {
        state.transport.failure ??= {
          stage: 'receive',
          category: 'protocol-error',
          delivery: 'unknown',
        };
        throw new Error('relay execution result was unavailable');
      }
      if (
        executed.token !== state.token ||
        executed.kind !== 'executed' ||
        (executed.termination !== 'exited' && executed.termination !== 'framework_timeout') ||
        typeof executed.exitCode !== 'number' ||
        typeof executed.stdout !== 'string' ||
        !validProcessDiagnostic(executed.diagnostic)
      ) {
        state.transport.failure ??= {
          stage: 'receive',
          category: 'protocol-error',
          delivery: 'unknown',
        };
        throw new Error('relay returned an invalid execution result');
      }
      state.diagnostic = executed.diagnostic;
      return {
        termination: executed.termination,
        exitCode: executed.exitCode,
        stdout: executed.stdout,
        diagnostic: executed.diagnostic,
      };
    },
  };
}

function validProcessDiagnostic(value: unknown): value is {
  category:
    | 'none'
    | 'unstructured-output'
    | 'result-frame-missing'
    | 'result-frame-invalid'
    | 'result-frame-ambiguous'
    | 'result-frame-oversize'
    | 'execution-scope-unavailable';
  bytes?: number;
  sha256?: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const diagnostic = value as Record<string, unknown>;
  const fields = Object.keys(diagnostic);
  return (
    (diagnostic.category === 'none' && fields.length === 1) ||
    ([
      'unstructured-output',
      'result-frame-missing',
      'result-frame-invalid',
      'result-frame-ambiguous',
      'result-frame-oversize',
      'execution-scope-unavailable',
    ].includes(String(diagnostic.category)) &&
      fields.length === 3 &&
      typeof diagnostic.bytes === 'number' &&
      Number.isSafeInteger(diagnostic.bytes) &&
      diagnostic.bytes >= 0 &&
      typeof diagnostic.sha256 === 'string' &&
      /^[0-9a-f]{64}$/u.test(diagnostic.sha256))
  );
}

async function startTrial(
  framework: HarnessFramework,
  options: HarnessOptions,
  specPath: string,
  cell: ExperimentCell,
  subjectCredentialNames: readonly string[],
  signal?: AbortSignal,
): Promise<
  | { readonly kind: 'ready'; readonly state: RelayState }
  | Extract<ExecutorAttemptOutcome, { readonly kind: 'not_started' }>
> {
  const credentials = requireCredentials(cell.subject.credentials);
  const token = randomBytes(24).toString('hex');
  const trialsRoot = resolve(process.env[options.trialsRootEnv]!);
  await mkdir(trialsRoot, { recursive: true, mode: 0o700 });
  await chmod(trialsRoot, 0o700);
  const trialName = `${safeName(cell.id)}-${randomBytes(6).toString('hex')}`;
  const configPath = join(trialsRoot, `${trialName}.json`);
  const trialPath = join(trialsRoot, trialName);
  const task = decodeTask(framework, options, cell);
  const timeoutMultiplier = positive(cell.budget.timeoutMultiplier, 'budget.timeoutMultiplier');
  const egressPaths = await resolveEgressPaths(options);
  const environmentConfig = resolveEnvironmentConfig(options, egressPaths, framework, trialPath);
  const networkPolicyPath = egressPaths?.networkPolicyPath;
  const executionEnvironment = {
    ...UNATTENDED_EXECUTION_ENVIRONMENT,
    ...egressExecutionEnvironment(options.egressProxy),
  };
  const environment = createHarnessPreparationEnvironment({
    subjectCredentialNames: [...subjectCredentialNames, ...cell.subject.credentials],
    declared: options.preparationEnvironment,
    ...(options.egressProxy && networkPolicyPath
      ? {
          egress: {
            allowedHost: options.egressProxy.allowedHost,
            networkPolicyPath,
          },
        }
      : {}),
  });
  const server = createServer();
  const connections = new Set<Socket>();
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.on('error', () => undefined);
    socket.once('close', () => connections.delete(socket));
  });
  let child: ChildProcess | undefined;
  let serverClosed: Promise<void> | undefined;
  const stopServer = (destroyConnections = false) => {
    serverClosed ??= closeServer(server);
    if (destroyConnections) {
      for (const socket of connections) socket.destroy();
    }
    return serverClosed;
  };
  let stage: 'spawn' | 'exit-before-ready' | 'ready-decode' = 'spawn';
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('relay did not bind TCP');
    await writeFile(
      configPath,
      `${JSON.stringify({
        task,
        trial_name: trialName,
        trials_dir: trialsRoot,
        timeout_multiplier: timeoutMultiplier,
        agent: {
          import_path: 'relay_agent:RelayAgent',
          kwargs: {
            relay_host: '127.0.0.1',
            relay_port: address.port,
            relay_token: token,
            teardown_timeout_ms: PYTHON_TEARDOWN_DEADLINE_MS,
          },
        },
        environment: environmentConfig,
        ...(options.egressProxy
          ? {
              artifacts: [
                {
                  source: '/opt/maka-egress-state/hits.jsonl',
                  destination: EGRESS_AUDIT_DESTINATION,
                  service: 'maka-eval-mitmproxy',
                },
              ],
            }
          : {}),
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    child = spawn(
      process.env[options.pythonPathEnv]!,
      [
        join(BUNDLED_HARNESS_RELAY_ROOT, 'run_trial.py'),
        framework,
        options.frameworkVersion,
        configPath,
      ],
      { cwd: dirname(specPath), env: environment, stdio: 'ignore' },
    );
    await once(child, 'spawn', signal ? { signal } : undefined);
    stage = 'exit-before-ready';
    const exitedBeforeReady = once(child, 'exit').then(([code]) => {
      throw new Error(`Trial exited before Agent.run (${code})`);
    });
    const connectionWait = new AbortController();
    const connectionSignal = signal
      ? AbortSignal.any([signal, connectionWait.signal])
      : connectionWait.signal;
    let socket: Socket;
    try {
      socket = await Promise.race([
        once(server, 'connection', { signal: connectionSignal }).then(
          ([connected]) => connected as Socket,
        ),
        exitedBeforeReady,
      ]);
    } finally {
      connectionWait.abort();
    }
    const relayClosed = stopServer();
    stage = 'ready-decode';
    const transport = createRelayTransport(socket);
    transport.stage = 'receive';
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY })[
      Symbol.asyncIterator
    ]();
    const ready = await abortable(Promise.race([readLine(lines), exitedBeforeReady]), signal);
    if (
      ready.token !== token ||
      ready.kind !== 'ready' ||
      typeof ready.instruction !== 'string' ||
      typeof ready.cwd !== 'string' ||
      !ready.cwd.startsWith('/')
    ) {
      throw new Error('relay returned an invalid ready message');
    }
    return {
      kind: 'ready',
      state: {
        child,
        transport,
        closeRelay: async () => {
          for (const connection of connections) connection.destroy();
          await relayClosed;
        },
        lines,
        token,
        trialName,
        trialPath,
        taskInput: ready.instruction,
        credentials,
        cwd: ready.cwd,
        executionEnvironment,
        used: false,
      },
    };
  } catch (error) {
    const relayClosed = stopServer(true);
    if (child?.pid !== undefined) {
      await waitForTrial(child, {
        phase: 'unused',
        deadlineMs: TERM_SETTLEMENT_DEADLINE_MS,
      });
    }
    await relayClosed;
    await unlink(configPath).catch(() => undefined);
    await mkdir(trialPath, { recursive: true, mode: 0o700 });
    const diagnosticPath = 'preparation-error.json';
    const code = preparationCode(stage, child?.exitCode ?? null, signal);
    await writeFile(
      join(trialPath, diagnosticPath),
      `${JSON.stringify({
        stage,
        framework,
        code,
        errorCode: safeErrorCode(error),
        exitCode: child?.exitCode ?? null,
        signal: child?.signalCode ?? null,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    return notStarted(code, [
      { kind: 'executor-preparation', framework, trialName, path: diagnosticPath },
    ]);
  }
}

function createRelayTransport(socket: Socket): RelayTransport {
  const transport: RelayTransport = { socket, stage: 'ready' };
  socket.on('error', (error: NodeJS.ErrnoException) => {
    transport.failure ??= {
      stage: transport.stage,
      category: relayTransportCategory(error.code),
      delivery: 'unknown',
    };
  });
  return transport;
}

function sendRelayMessage(
  transport: RelayTransport,
  stage: RelayTransportStage,
  value: Record<string, unknown>,
  end = false,
): boolean {
  transport.stage = stage;
  const socket = transport.socket;
  if (socket.destroyed || !socket.writable || socket.writableEnded || transport.failure) {
    transport.failure = {
      stage,
      category: transport.failure?.category ?? 'peer-closed',
      delivery: 'not-delivered',
    };
    return false;
  }
  try {
    const payload = `${JSON.stringify(value)}\n`;
    if (end) socket.end(payload);
    else {
      socket.write(payload, (error) => {
        if (!error) return;
        transport.failure = {
          stage,
          category: relayTransportCategory((error as NodeJS.ErrnoException).code),
          delivery: 'unknown',
        };
      });
    }
    return true;
  } catch (error) {
    transport.failure = {
      stage,
      category: relayTransportCategory((error as NodeJS.ErrnoException).code),
      delivery: 'not-delivered',
    };
    return false;
  }
}

function relayTransportCategory(code: string | undefined): RelayTransportFailure['category'] {
  if (code === 'EPIPE') return 'broken-pipe';
  if (code === 'ECONNRESET') return 'connection-reset';
  if (code === 'ERR_STREAM_WRITE_AFTER_END') return 'peer-closed';
  return 'transport-error';
}

function notStarted(
  code: ExecutorPreparationCode,
  artifacts: readonly JsonObject[] = [],
): Extract<ExecutorAttemptOutcome, { readonly kind: 'not_started' }> {
  return { kind: 'not_started', code, artifacts };
}

function preparationCode(
  stage: 'spawn' | 'exit-before-ready' | 'ready-decode',
  exitCode: number | null,
  signal?: AbortSignal,
): ExecutorPreparationCode {
  if (signal?.aborted) return 'cancelled';
  if (stage === 'exit-before-ready' && exitCode === 78) return 'framework-version-mismatch';
  if (stage === 'spawn') return 'spawn-failed';
  if (stage === 'ready-decode') return 'invalid-ready';
  return 'exit-before-ready';
}

function mergeExecutionEnvironment(
  required: Readonly<Record<string, string>>,
  subject: Readonly<Record<string, string>>,
): Record<string, string> {
  const overlap = Object.keys(required).filter((name) => Object.hasOwn(subject, name));
  if (overlap.length > 0) {
    throw new Error(
      `subject environment overrides Eval execution environment: ${overlap.join(', ')}`,
    );
  }
  return { ...subject, ...required };
}

// Every subject runs unattended in a fresh container, where a package manager
// that stops to ask a question is indistinguishable from one that hung. That is
// a property of the environment, not of any one arm: tasks install packages, and
// subjects only decide when.
const UNATTENDED_EXECUTION_ENVIRONMENT: Readonly<Record<string, string>> = {
  DEBIAN_FRONTEND: 'noninteractive',
  TZ: 'Etc/UTC',
};

function egressExecutionEnvironment(
  options: HarnessOptions['egressProxy'],
): Readonly<Record<string, string>> {
  if (!options) return {};
  const noProxy = '127.0.0.1,localhost';
  return {
    HTTP_PROXY: options.proxyUrl,
    HTTPS_PROXY: options.proxyUrl,
    http_proxy: options.proxyUrl,
    https_proxy: options.proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    SSL_CERT_FILE: options.containerCaPath,
    REQUESTS_CA_BUNDLE: options.containerCaPath,
    CURL_CA_BUNDLE: options.containerCaPath,
    GIT_SSL_CAINFO: options.containerCaPath,
    NODE_EXTRA_CA_CERTS: options.containerCaPath,
  };
}

function safeErrorCode(error: unknown): string | null {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code && ['ENOENT', 'EACCES', 'EPERM'].includes(code) ? code : null;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
}

export const EGRESS_AUDIT_DESTINATION = 'egress-hits.jsonl';
export const EGRESS_AUDIT_ARTIFACT_PATH = `artifacts/${EGRESS_AUDIT_DESTINATION}`;

export function collectEgressAuditArtifact(
  audit: Buffer | undefined,
  expected: boolean,
): {
  readonly missing: boolean;
  readonly failureReason: string | null;
  readonly artifacts: readonly JsonObject[];
} {
  if (!expected) return { missing: false, failureReason: null, artifacts: [] };
  if (audit === undefined) {
    return {
      missing: true,
      failureReason: 'egress audit log missing',
      artifacts: [{ kind: 'egress-audit-missing', path: EGRESS_AUDIT_ARTIFACT_PATH }],
    };
  }
  const forensics = inspectEgressAudit(audit);
  return {
    missing: false,
    failureReason: null,
    artifacts: [
      {
        kind: 'egress-audit',
        path: EGRESS_AUDIT_ARTIFACT_PATH,
        bytes: audit.byteLength,
        sha256: `sha256:${createHash('sha256').update(audit).digest('hex')}`,
        truncated: forensics.truncated,
        policyErrorCount: forensics.policyErrorCount,
        malformedLineCount: forensics.malformedLineCount,
      },
    ],
  };
}

function inspectEgressAudit(audit: Buffer): {
  readonly truncated: boolean;
  readonly policyErrorCount: number;
  readonly malformedLineCount: number;
} {
  let truncated = false;
  let policyErrorCount = 0;
  let malformedLineCount = 0;
  for (const line of audit.toString('utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      malformedLineCount += 1;
      continue;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      malformedLineCount += 1;
      continue;
    }
    const ruleId = (record as { ruleId?: unknown }).ruleId;
    if (ruleId === 'audit_truncated') truncated = true;
    if (ruleId === 'policy_error') policyErrorCount += 1;
  }
  return { truncated, policyErrorCount, malformedLineCount };
}

async function readVerification(
  state: RelayState,
  cell: ExperimentCell,
  framework: HarnessFramework,
  expectEgressAudit: boolean,
): Promise<ExecutorVerification> {
  const result = JSON.parse(await readFile(join(state.trialPath, 'result.json'), 'utf8')) as {
    exception_info?: { exception_type?: unknown } | null;
    verifier_result?: { rewards?: Record<string, number> | null } | null;
  };
  const score = result.verifier_result?.rewards?.[rewardKey(cell)] ?? null;
  const subjectException = ['AgentTimeoutError', 'NonZeroAgentExitCodeError'].includes(
    String(result.exception_info?.exception_type),
  );
  if (result.exception_info && !subjectException) {
    throw new Error('Trial failed outside subject execution');
  }
  const egressAuditPath = join(state.trialPath, EGRESS_AUDIT_ARTIFACT_PATH);
  let egressAudit: Buffer | undefined;
  try {
    egressAudit = await readFile(egressAuditPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (expectEgressAudit && code !== 'ENOENT') {
      return {
        status: 'infra_failed',
        score,
        failureReason: `failed to read egress audit log ${egressAuditPath}${code ? ` (${code})` : ''}`,
        artifacts: [
          { kind: 'trial', framework: cell.executor.kind, trialName: state.trialName },
          ...(await collectedArtifactInventory(state.trialPath, framework)),
          { kind: 'egress-audit-unreadable', path: EGRESS_AUDIT_ARTIFACT_PATH },
        ],
      };
    }
  }
  const audit = collectEgressAuditArtifact(egressAudit, expectEgressAudit);
  return {
    status: audit.failureReason
      ? 'infra_failed'
      : score === null
        ? 'infra_failed'
        : subjectException
          ? 'subject_failed'
          : 'completed',
    score,
    failureReason: audit.failureReason ?? (score === null ? 'verifier produced no reward' : null),
    artifacts: [
      { kind: 'trial', framework: cell.executor.kind, trialName: state.trialName },
      ...(await collectedArtifactInventory(state.trialPath, framework)),
      ...audit.artifacts,
    ],
  };
}

async function collectedArtifactInventory(
  trialPath: string,
  framework: HarnessFramework,
): Promise<JsonObject[]> {
  const root =
    framework === 'pier'
      ? join(trialPath, 'artifacts')
      : join(trialPath, 'artifacts', 'logs', 'artifacts');
  const files: JsonObject[] = [];
  const targets = [
    join(root, basename(MAKA_RUNTIME_ARTIFACT_PATH)),
    join(root, basename(MAKA_SUBJECT_STDOUT_PATH)),
    join(root, basename(MAKA_SUBJECT_STDERR_PATH)),
  ];
  for (const target of targets) {
    await walkCollectedArtifacts(trialPath, target, files).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return files.sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

async function walkCollectedArtifacts(
  trialPath: string,
  current: string,
  files: JsonObject[],
): Promise<void> {
  const metadata = await lstat(current);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isFile()) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(current)) hash.update(chunk as Buffer);
    files.push({
      kind: 'collected-artifact',
      path: relative(trialPath, current).split(sep).join('/'),
      bytes: metadata.size,
      sha256: `sha256:${hash.digest('hex')}`,
    });
    return;
  }
  if (!metadata.isDirectory()) return;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    await walkCollectedArtifacts(trialPath, path, files);
  }
}

export interface HarnessOptions {
  readonly frameworkVersion: string;
  readonly pythonPathEnv: string;
  readonly trialsRootEnv: string;
  readonly tasksRootEnv?: string;
  readonly environment: JsonObject;
  readonly preparationEnvironment: readonly string[];
  readonly egressProxy?: {
    readonly composeSourceEnv: string;
    readonly composeRelativePath: string;
    readonly networkPolicyRelativePath: string;
    readonly proxyUrl: string;
    readonly allowedHost: string;
    readonly containerCaPath: string;
  };
  readonly mounts: readonly {
    readonly sourceEnv: string;
    readonly target: string;
    readonly readOnly: true;
  }[];
}

function decodeHarnessOptions(value: JsonObject, framework: HarnessFramework): HarnessOptions {
  if (!Object.hasOwn(value, 'preparationEnvironment')) {
    throw new Error('executor.config.preparationEnvironment is required');
  }
  const fields = [
    'frameworkVersion',
    'pythonPathEnv',
    'trialsRootEnv',
    'environment',
    'preparationEnvironment',
    'mounts',
  ];
  // Only the Harbor branch of run_trial.py applies the namespace policy, so a
  // pier spec declaring egressProxy would set the proxy up and inject its
  // environment while enforcement silently did not exist.
  if (framework === 'pier' && Object.hasOwn(value, 'egressProxy')) {
    throw new Error(
      'executor.config.egressProxy is Harbor-only: pier does not apply the subject namespace policy',
    );
  }
  if (Object.hasOwn(value, 'egressProxy')) fields.push('egressProxy');
  if (framework === 'pier') fields.push('tasksRootEnv');
  const options = exact(value, fields, 'executor.config');
  const preparationEnvironment = array(
    options.preparationEnvironment,
    'preparationEnvironment',
  ).map((name, index) => machinePathEnv(name, `preparationEnvironment[${index}]`));
  if (new Set(preparationEnvironment).size !== preparationEnvironment.length) {
    throw new Error('preparationEnvironment must contain unique names');
  }
  const decoded: HarnessOptions = {
    frameworkVersion: text(options.frameworkVersion, 'frameworkVersion'),
    pythonPathEnv: machinePathEnv(options.pythonPathEnv, 'pythonPathEnv'),
    trialsRootEnv: machinePathEnv(options.trialsRootEnv, 'trialsRootEnv'),
    environment: decodeJsonObject(options.environment, 'environment'),
    preparationEnvironment,
    ...(Object.hasOwn(options, 'egressProxy')
      ? { egressProxy: decodeEgressProxy(options.egressProxy) }
      : {}),
    mounts: array(options.mounts, 'mounts').map((mount, index) => decodeMount(mount, index)),
    ...(framework === 'pier'
      ? { tasksRootEnv: machinePathEnv(options.tasksRootEnv, 'tasksRootEnv') }
      : {}),
  };
  if (framework === 'pier') {
    const reservedTargets = PIER_FRAMEWORK_LOG_MOUNTS.map((mount) => mount.target);
    const collision = decoded.mounts.find((mount) => {
      const target = posix.normalize(mount.target);
      return reservedTargets.some(
        (reserved) => target === reserved || target.startsWith(`${reserved}/`),
      );
    });
    if (collision) {
      throw new Error(`Pier mount target ${collision.target} is reserved for framework logs`);
    }
  }
  for (const name of [
    decoded.pythonPathEnv,
    decoded.trialsRootEnv,
    decoded.tasksRootEnv,
    decoded.egressProxy?.composeSourceEnv,
  ]) {
    if (name && !process.env[name]) throw new Error(`machine path ${name} is unavailable`);
  }
  return decoded;
}

function decodeEgressProxy(value: unknown): NonNullable<HarnessOptions['egressProxy']> {
  const proxy = exact(
    value,
    [
      'composeSourceEnv',
      'composeRelativePath',
      'networkPolicyRelativePath',
      'proxyUrl',
      'allowedHost',
      'containerCaPath',
    ],
    'egressProxy',
  );
  const proxyUrl = text(proxy.proxyUrl, 'egressProxy.proxyUrl');
  if (!URL.canParse(proxyUrl) || new URL(proxyUrl).protocol !== 'http:') {
    throw new Error('egressProxy.proxyUrl must be an HTTP proxy URL');
  }
  return {
    composeSourceEnv: machinePathEnv(proxy.composeSourceEnv, 'egressProxy.composeSourceEnv'),
    composeRelativePath: relativePath(proxy.composeRelativePath, 'egressProxy.composeRelativePath'),
    networkPolicyRelativePath: relativePath(
      proxy.networkPolicyRelativePath,
      'egressProxy.networkPolicyRelativePath',
    ),
    proxyUrl,
    allowedHost: hostName(proxy.allowedHost, 'egressProxy.allowedHost'),
    containerCaPath: absolute(proxy.containerCaPath, 'egressProxy.containerCaPath'),
  };
}

function decodeMount(value: unknown, index: number) {
  const mount = exact(value, ['sourceEnv', 'target', 'readOnly'], `mounts[${index}]`);
  const sourceEnv = machinePathEnv(mount.sourceEnv, `mounts[${index}].sourceEnv`);
  if (!process.env[sourceEnv]) throw new Error(`machine path ${sourceEnv} is unavailable`);
  if (mount.readOnly !== true) throw new Error(`mounts[${index}] must be read-only`);
  return {
    sourceEnv,
    target: absolute(mount.target, `mounts[${index}].target`),
    readOnly: true as const,
  };
}

function resolveMounts(mounts: HarnessOptions['mounts']) {
  return mounts.map((mount) => ({
    type: 'bind',
    source: resolve(process.env[mount.sourceEnv]!),
    target: mount.target,
    read_only: true,
  }));
}

interface ResolvedEgressPaths {
  readonly composePath: string;
  readonly networkPolicyPath: string;
}

function resolveEnvironmentConfig(
  options: HarnessOptions,
  egressPaths: ResolvedEgressPaths | undefined,
  framework: HarnessFramework,
  trialPath: string,
): JsonObject {
  const configuredMounts = resolveMounts(options.mounts);
  const mounts =
    framework === 'pier'
      ? [
          ...configuredMounts,
          ...PIER_FRAMEWORK_LOG_MOUNTS.map(({ directory, target }) => ({
            type: 'bind',
            source: join(trialPath, directory),
            target,
          })),
        ]
      : configuredMounts;
  const base = { ...options.environment, mounts };
  if (!options.egressProxy) return base;
  if (!egressPaths) throw new Error('egress proxy paths are unavailable');
  return { ...base, extra_docker_compose: [egressPaths.composePath] };
}

async function resolveEgressPaths(
  options: HarnessOptions,
): Promise<ResolvedEgressPaths | undefined> {
  if (!options.egressProxy) return undefined;
  const source = resolve(process.env[options.egressProxy.composeSourceEnv]!);
  const [composePath, networkPolicyPath] = await Promise.all([
    resolveRealPathWithinRoot(
      source,
      options.egressProxy.composeRelativePath,
      'egress proxy compose path',
    ),
    resolveRealPathWithinRoot(
      source,
      options.egressProxy.networkPolicyRelativePath,
      'egress network policy path',
    ),
  ]);
  return { composePath, networkPolicyPath };
}

function decodeTask(framework: HarnessFramework, options: HarnessOptions, cell: ExperimentCell) {
  if (framework === 'harbor') {
    const benchmark = exact(cell.benchmark.config, ['repository'], 'benchmark.config');
    const task = exact(cell.task.config, ['harbor'], 'task.config');
    const harbor = exact(task.harbor, ['path'], 'task.config.harbor');
    const revision = text(cell.benchmark.version, 'benchmark.version');
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(revision)) {
      throw new Error('Harbor benchmark.version must be a complete Git commit');
    }
    return {
      path: text(harbor.path, 'task.config.harbor.path'),
      git_url: text(benchmark.repository, 'benchmark.config.repository'),
      git_commit_id: revision,
    };
  }
  const task = exact(cell.task.config, ['pier'], 'task.config');
  const pier = exact(task.pier, ['path'], 'task.config.pier');
  const root = resolve(process.env[options.tasksRootEnv!]!);
  const path = resolve(root, text(pier.path, 'task.config.pier.path'));
  const fromRoot = relative(root, path);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`))
    throw new Error('Pier task escapes tasksRoot');
  return { path };
}

function rewardKey(cell: ExperimentCell): string {
  return text(exact(cell.verifier, ['reward'], 'verifier').reward, 'verifier.reward');
}

function requireCredentials(names: readonly string[]) {
  return Object.freeze(
    Object.fromEntries(
      names.map((name) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
          throw new Error(`invalid credential name ${name}`);
        const value = process.env[name];
        if (!value) throw new Error(`subject credential ${name} is required`);
        return [name, value];
      }),
    ),
  );
}

async function readLine(lines: AsyncIterator<string>): Promise<Record<string, unknown>> {
  const line = await lines.next();
  if (line.done) throw new Error('relay closed before settlement');
  return JSON.parse(line.value) as Record<string, unknown>;
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolveOperation, rejectOperation) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => settle(() => rejectOperation(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => settle(() => resolveOperation(value)),
      (error: unknown) => settle(() => rejectOperation(error)),
    );
  });
}

type TrialWait =
  | { readonly phase: 'completion' }
  | { readonly phase: 'abort'; readonly deadlineMs: number }
  | { readonly phase: 'unused'; readonly deadlineMs: number };

type TrialWaitEvidence =
  | {
      readonly phase: 'completion';
      readonly deadlineMs: null;
      readonly escalation: 'none';
      readonly outcome: 'completed' | 'failed';
    }
  | {
      readonly phase: 'abort' | 'unused';
      readonly deadlineMs: number;
      readonly escalation: 'term';
      readonly outcome: 'confirmed' | 'terminated';
    }
  | {
      readonly phase: 'abort' | 'unused';
      readonly deadlineMs: number;
      readonly escalation: 'kill';
      readonly outcome: 'killed';
    }
  | {
      readonly phase: 'abort' | 'unused';
      readonly deadlineMs: number;
      readonly escalation: 'detached';
      readonly outcome: 'unsettled';
    };

const RELAY_SETTLEMENT_DEADLINE_MS = 120_000;
const PYTHON_TEARDOWN_DEADLINE_MS = 110_000;
const TERM_SETTLEMENT_DEADLINE_MS = 20_000;
const KILL_SETTLEMENT_DEADLINE_MS = 5_000;

async function waitForTrial(child: ChildProcess, wait: TrialWait): Promise<TrialWaitEvidence> {
  const exit =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : once(child, 'exit').then(([code, childSignal]) => ({ code, signal: childSignal }));
  if (wait.phase === 'completion') {
    const completed = await exit;
    return {
      phase: wait.phase,
      deadlineMs: null,
      escalation: 'none',
      outcome: completed.code === 0 && completed.signal === null ? 'completed' : 'failed',
    };
  }

  child.kill('SIGTERM');
  const terminated = await within(exit, wait.deadlineMs);
  if (terminated) {
    return {
      phase: wait.phase,
      deadlineMs: wait.deadlineMs,
      escalation: 'term',
      outcome: terminated.code === 0 && terminated.signal === null ? 'confirmed' : 'terminated',
    };
  }
  child.kill('SIGKILL');
  const killed = await within(exit, KILL_SETTLEMENT_DEADLINE_MS);
  if (killed) {
    return {
      phase: wait.phase,
      deadlineMs: wait.deadlineMs,
      escalation: 'kill',
      outcome: 'killed',
    };
  }
  child.unref();
  return {
    phase: wait.phase,
    deadlineMs: wait.deadlineMs,
    escalation: 'detached',
    outcome: 'unsettled',
  };
}

function finalizationConfirmed(evidence: TrialWaitEvidence): boolean {
  return evidence.outcome === 'completed' || evidence.outcome === 'confirmed';
}

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: number | NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function exact(value: unknown, fields: readonly string[], where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${where} must be an object`);
  const record = value as Record<string, unknown>;
  if (
    fields.some((field) => !Object.hasOwn(record, field)) ||
    Object.keys(record).some((field) => !fields.includes(field))
  ) {
    throw new Error(`${where} fields are invalid`);
  }
  return record;
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${where} is required`);
  return value;
}

function machinePathEnv(value: unknown, where: string): string {
  const name = text(value, where);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error(`${where} is invalid`);
  return name;
}

function relativePath(value: unknown, where: string): string {
  const path = text(value, where);
  if (path.startsWith('/') || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`${where} must stay within its source root`);
  }
  return path;
}

function hostName(value: unknown, where: string): string {
  const host = text(value, where).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host)) {
    throw new Error(`${where} must be a hostname`);
  }
  return host;
}

function absolute(value: unknown, where: string): string {
  const path = text(value, where);
  if (!path.startsWith('/')) throw new Error(`${where} must be absolute`);
  return path;
}

function positive(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`${where} must be positive`);
  return value;
}

function safeName(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/gu, '-').slice(0, 80);
}
