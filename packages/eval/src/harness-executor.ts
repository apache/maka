import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { decodeJsonObject, type ExperimentCell, type JsonObject } from './experiment.js';
import {
  type ExecutorAttemptOutcome,
  type ExperimentExecutor,
  type ExecutorPreparationCode,
  type ExecutorVerification,
  type SubjectExecutionContext,
} from './runner.js';
import type { EvalResult } from './result.js';

type Framework = 'harbor' | 'pier';
type RelayTransportStage = 'ready' | 'execute' | 'receive' | 'decision';

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

export function createHarborExecutor(config: JsonObject, specPath: string): ExperimentExecutor {
  return createHarnessExecutor('harbor', config, specPath);
}

export function createPierExecutor(config: JsonObject, specPath: string): ExperimentExecutor {
  return createHarnessExecutor('pier', config, specPath);
}

function createHarnessExecutor(
  framework: Framework,
  config: JsonObject,
  specPath: string,
): ExperimentExecutor {
  const options = decodeOptions(config, framework);
  const executor: ExperimentExecutor = {
    kind: framework,
    validate: (cell) => {
      decodeTask(framework, options, cell);
    },
    runAttempt: (input, operation) =>
      runHarnessAttempt(framework, options, specPath, input, operation),
  };
  return executor;
}

async function runHarnessAttempt(
  framework: Framework,
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
        const verification = await readVerification(state, cell);
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
  return {
    cwd: state.cwd,
    taskInput: state.taskInput,
    metadata: { trialName: state.trialName },
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
      const resultToken = randomBytes(16).toString('hex');
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
  framework: Framework,
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
  const environmentConfig = { ...options.environment, mounts: resolveMounts(options.mounts) };
  const relayPath = resolve(dirname(fileURLToPath(import.meta.url)), '../harbor');
  const executionEnvironment = egressExecutionEnvironment(options.egressProxy);
  const environment = preparationEnvironment(
    framework,
    relayPath,
    [...subjectCredentialNames, ...cell.subject.credentials],
    options.preparationEnvironment,
  );
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
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    child = spawn(
      process.env[options.pythonPathEnv]!,
      [join(relayPath, 'run_trial.py'), framework, options.frameworkVersion, configPath],
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

function preparationEnvironment(
  framework: Framework,
  relayPath: string,
  subjectCredentialNames: readonly string[],
  declared: readonly string[],
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'HOME',
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'XDG_CACHE_HOME',
    ...declared,
  ]);
  const credentials = new Set(subjectCredentialNames);
  const inherited = Object.fromEntries(
    [...allowed].flatMap((name) => {
      const value = process.env[name];
      return value === undefined || credentials.has(name) ? [] : [[name, value]];
    }),
  );
  return {
    ...inherited,
    MAKA_EVAL_FRAMEWORK: framework,
    PYTHONPATH: [relayPath, inherited.PYTHONPATH].filter(Boolean).join(delimiter),
  };
}

function mergeExecutionEnvironment(
  required: Readonly<Record<string, string>>,
  subject: Readonly<Record<string, string>>,
): Record<string, string> {
  const overlap = Object.keys(required).filter((name) => Object.hasOwn(subject, name));
  if (overlap.length > 0) {
    throw new Error(`subject environment overrides Eval egress policy: ${overlap.join(', ')}`);
  }
  return { ...subject, ...required };
}

function egressExecutionEnvironment(
  options: HarnessOptions['egressProxy'],
): Readonly<Record<string, string>> {
  if (!options) return {};
  const proxyUrl = process.env[options.urlEnv]!;
  if (!URL.canParse(proxyUrl) || new URL(proxyUrl).protocol !== 'http:') {
    throw new Error(`machine path ${options.urlEnv} must be an HTTP proxy URL`);
  }
  const proxyHost = new URL(proxyUrl).hostname;
  const noProxy = `127.0.0.1,localhost,${proxyHost}`;
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    SSL_CERT_FILE: options.containerCaPath,
    REQUESTS_CA_BUNDLE: options.containerCaPath,
    CURL_CA_BUNDLE: options.containerCaPath,
    GIT_SSL_CAINFO: options.containerCaPath,
    NODE_EXTRA_CA_CERTS: options.containerCaPath,
    NODE_OPTIONS: '--use-env-proxy',
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

async function readVerification(
  state: RelayState,
  cell: ExperimentCell,
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
  return {
    status: score === null ? 'infra_failed' : subjectException ? 'subject_failed' : 'completed',
    score,
    failureReason: score === null ? 'verifier produced no reward' : null,
    artifacts: [{ kind: 'trial', framework: cell.executor.kind, trialName: state.trialName }],
  };
}

interface HarnessOptions {
  readonly frameworkVersion: string;
  readonly pythonPathEnv: string;
  readonly trialsRootEnv: string;
  readonly tasksRootEnv?: string;
  readonly environment: JsonObject;
  readonly preparationEnvironment: readonly string[];
  readonly egressProxy?: {
    readonly urlEnv: string;
    readonly caCertificatePathEnv: string;
    readonly containerCaPath: string;
  };
  readonly mounts: readonly {
    readonly sourceEnv: string;
    readonly target: string;
    readonly readOnly: true;
  }[];
}

function decodeOptions(value: JsonObject, framework: Framework): HarnessOptions {
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
  if (preparationEnvironment.includes('MAKA_EVAL_FRAMEWORK')) {
    throw new Error('preparationEnvironment contains a reserved name');
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
  for (const name of [
    decoded.pythonPathEnv,
    decoded.trialsRootEnv,
    decoded.tasksRootEnv,
    decoded.egressProxy?.urlEnv,
    decoded.egressProxy?.caCertificatePathEnv,
  ]) {
    if (name && !process.env[name]) throw new Error(`machine path ${name} is unavailable`);
  }
  return decoded;
}

function decodeEgressProxy(value: unknown): NonNullable<HarnessOptions['egressProxy']> {
  const proxy = exact(value, ['urlEnv', 'caCertificatePathEnv', 'containerCaPath'], 'egressProxy');
  return {
    urlEnv: machinePathEnv(proxy.urlEnv, 'egressProxy.urlEnv'),
    caCertificatePathEnv: machinePathEnv(
      proxy.caCertificatePathEnv,
      'egressProxy.caCertificatePathEnv',
    ),
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

function decodeTask(framework: Framework, options: HarnessOptions, cell: ExperimentCell) {
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
