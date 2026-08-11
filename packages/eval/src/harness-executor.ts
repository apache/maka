import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { decodeJsonObject, type ExperimentCell, type JsonObject } from './experiment.js';
import {
  ExecutorPreparationFailure,
  type ExperimentExecutor,
  type ExecutorVerification,
  type SubjectExecutionContext,
} from './runner.js';
import type { EvalResult } from './result.js';

type Framework = 'harbor' | 'pier';

const PREPARATION_STDERR_LIMIT = 64 * 1024;
const PREPARATION_REDACTION_OVERLAP = 8 * 1024;

interface RelayState {
  readonly child: ChildProcess;
  readonly server: Server;
  readonly socket: Socket;
  readonly lines: AsyncIterator<string>;
  readonly token: string;
  readonly trialName: string;
  readonly trialPath: string;
  readonly taskInput: string;
  readonly credentials: Readonly<Record<string, string>>;
  readonly containerCwd: string;
  used: boolean;
}

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
    runAttempt: (input, operation) =>
      runHarnessAttempt(framework, options, specPath, input, operation),
  };
  return executor;
}

async function runHarnessAttempt(
  framework: Framework,
  options: HarnessOptions,
  specPath: string,
  { cell, signal }: { readonly cell: ExperimentCell; readonly signal?: AbortSignal },
  operation: (attempt: {
    readonly context: SubjectExecutionContext;
    verify(): Promise<ExecutorVerification>;
  }) => Promise<EvalResult>,
): Promise<
  | { readonly kind: 'settled'; readonly value: EvalResult }
  | { readonly kind: 'indeterminate'; readonly value?: EvalResult }
> {
  if (signal?.aborted) return { kind: 'indeterminate' };
  const state = await startTrial(framework, options, specPath, cell, signal);
  let decision = false;
  let value: EvalResult | undefined;
  let hasValue = false;
  let clean = true;
  const decide = (kind: 'verify' | 'abort') => {
    if (decision) return;
    decision = true;
    state.socket.write(`${JSON.stringify({ token: state.token, kind })}\n`);
    state.socket.end();
  };
  try {
    value = await operation({
      context: relayContext(state, cell, signal),
      verify: async () => {
        decide('verify');
        clean = await waitForTrial(state.child, signal);
        if (!clean) throw new Error('Trial did not finalize cleanly');
        return readVerification(state, cell);
      },
    });
    hasValue = true;
  } finally {
    if (!decision) {
      if (state.used) decide('abort');
      else state.child.kill('SIGTERM');
      clean = await waitForTrial(state.child);
    }
    state.socket.destroy();
    await closeServer(state.server);
  }
  if (!clean) {
    return hasValue ? { kind: 'indeterminate', value } : { kind: 'indeterminate' };
  }
  if (!hasValue) throw new Error('executor operation did not settle');
  return { kind: 'settled', value };
}

function relayContext(
  state: RelayState,
  cell: ExperimentCell,
  signal?: AbortSignal,
): SubjectExecutionContext {
  return {
    cwd: state.containerCwd,
    taskInput: state.taskInput,
    metadata: { trialName: state.trialName },
    ...(signal ? { signal } : {}),
    execute: async (input) => {
      if (state.used) throw new Error('Trial already executed its subject');
      state.used = true;
      const credentials = Object.fromEntries(
        input.credentialNames.map((name) => {
          const value = state.credentials[name];
          if (value === undefined) throw new Error(`credential ${name} was not admitted`);
          return [name, value];
        }),
      );
      state.socket.write(
        `${JSON.stringify({
          token: state.token,
          kind: 'execute',
          command: input.command,
          args: input.args,
          cwd: state.containerCwd,
          credentials,
          ...(input.cancel ? { cancel: input.cancel } : {}),
        })}\n`,
      );
      const cancel = () => {
        state.socket.write(`${JSON.stringify({ token: state.token, kind: 'cancel' })}\n`);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      try {
        const executed = await readLine(state.lines);
        if (
          executed.token !== state.token ||
          executed.kind !== 'executed' ||
          (executed.termination !== 'exited' &&
            executed.termination !== 'framework_timeout' &&
            executed.termination !== 'cancelled') ||
          typeof executed.exitCode !== 'number' ||
          typeof executed.stdout !== 'string'
        ) {
          throw new Error('relay returned an invalid execution result');
        }
        return {
          termination: executed.termination,
          exitCode: executed.exitCode,
          stdout: executed.stdout,
        };
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

async function startTrial(
  framework: Framework,
  options: HarnessOptions,
  specPath: string,
  cell: ExperimentCell,
  signal?: AbortSignal,
): Promise<RelayState> {
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
  const environment: NodeJS.ProcessEnv = { ...process.env, MAKA_EVAL_FRAMEWORK: framework };
  for (const name of cell.subject.credentials) delete environment[name];
  environment.PYTHONPATH = [relayPath, process.env.PYTHONPATH].filter(Boolean).join(sep);
  const server = createServer();
  let child: ChildProcess | undefined;
  let connectedSocket: Socket | undefined;
  let abort: (() => void) | undefined;
  const exactSecrets = [token, ...Object.values(credentials)];
  const stderr = new BoundedCapture(
    PREPARATION_STDERR_LIMIT +
      Math.max(
        PREPARATION_REDACTION_OVERLAP,
        ...exactSecrets.map((secret) => Buffer.byteLength(secret)),
      ),
  );
  let stderrClosed: Promise<unknown> | undefined;
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
          kwargs: { relay_host: '127.0.0.1', relay_port: address.port, relay_token: token },
        },
        environment: environmentConfig,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    child = spawn(
      process.env[options.pythonPathEnv]!,
      [join(relayPath, 'run_trial.py'), framework, options.frameworkVersion, configPath],
      { cwd: dirname(specPath), env: environment, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child.stderr!.on('data', (chunk: Buffer) => stderr.append(chunk));
    stderrClosed = once(child.stderr!, 'close');
    abort = () => child?.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const socket = await Promise.race([
      once(server, 'connection').then(([connected]) => connected as Socket),
      once(child, 'exit').then(([code]) => {
        throw new Error(`Trial exited before Agent.run (${code})`);
      }),
    ]);
    connectedSocket = socket;
    const lines = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY })[
      Symbol.asyncIterator
    ]();
    const ready = await readLine(lines);
    if (ready.token !== token || ready.kind !== 'ready' || typeof ready.instruction !== 'string') {
      throw new Error('relay returned an invalid ready message');
    }
    return {
      child,
      server,
      socket,
      lines,
      token,
      trialName,
      trialPath,
      taskInput: ready.instruction,
      credentials,
      containerCwd: options.containerCwd,
      used: false,
    };
  } catch (error) {
    if (child?.pid !== undefined) {
      child.kill('SIGTERM');
      await waitForTrial(child);
    }
    await stderrClosed?.catch(() => undefined);
    connectedSocket?.destroy();
    await closeServer(server);
    await mkdir(trialPath, { recursive: true, mode: 0o700 });
    const diagnosticPath = 'preparation-error.json';
    const diagnostic = sanitizeDiagnostic(stderr.text(), exactSecrets, PREPARATION_STDERR_LIMIT);
    await writeFile(
      join(trialPath, diagnosticPath),
      `${JSON.stringify({
        stage: 'executor-preparation',
        framework,
        exitCode: child?.exitCode ?? null,
        signal: child?.signalCode ?? null,
        stderr: diagnostic.text,
        truncated: stderr.truncated || diagnostic.truncated,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    throw new ExecutorPreparationFailure(
      [{ kind: 'executor-preparation', framework, trialName, path: diagnosticPath }],
      { cause: error },
    );
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

class BoundedCapture {
  #value = Buffer.alloc(0);
  #total = 0;

  constructor(readonly limit: number) {}

  append(chunk: Buffer): void {
    this.#total += chunk.length;
    this.#value = Buffer.concat([this.#value, chunk]).subarray(-this.limit);
  }

  get truncated(): boolean {
    return this.#total > this.limit;
  }

  text(): string {
    return this.#value.toString('utf8');
  }
}

function sanitizeDiagnostic(
  value: string,
  exactSecrets: readonly string[],
  limit: number,
): { readonly text: string; readonly truncated: boolean } {
  let redacted = value;
  for (const secret of exactSecrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  redacted = redacted
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/giu, '$1[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)[^\s]+/giu,
      '$1[REDACTED]',
    )
    .replace(
      /(--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s+)[^\s]+/giu,
      '$1[REDACTED]',
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/\bcommand\b[^\r\n]*/giu, 'command [REDACTED]');
  const bytes = Buffer.from(redacted);
  if (bytes.length <= limit) return { text: redacted, truncated: false };
  return { text: bytes.subarray(-limit).toString('utf8'), truncated: true };
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
  readonly containerCwd: string;
  readonly environment: JsonObject;
  readonly mounts: readonly {
    readonly sourceEnv: string;
    readonly target: string;
    readonly readOnly: true;
  }[];
}

function decodeOptions(value: JsonObject, framework: Framework): HarnessOptions {
  const fields = [
    'frameworkVersion',
    'pythonPathEnv',
    'trialsRootEnv',
    'containerCwd',
    'environment',
    'mounts',
  ];
  if (framework === 'pier') fields.push('tasksRootEnv');
  const options = exact(value, fields, 'executor.config');
  const decoded: HarnessOptions = {
    frameworkVersion: text(options.frameworkVersion, 'frameworkVersion'),
    pythonPathEnv: machinePathEnv(options.pythonPathEnv, 'pythonPathEnv'),
    trialsRootEnv: machinePathEnv(options.trialsRootEnv, 'trialsRootEnv'),
    containerCwd: absolute(options.containerCwd, 'containerCwd'),
    environment: decodeJsonObject(options.environment, 'environment'),
    mounts: array(options.mounts, 'mounts').map((mount, index) => decodeMount(mount, index)),
    ...(framework === 'pier'
      ? { tasksRootEnv: machinePathEnv(options.tasksRootEnv, 'tasksRootEnv') }
      : {}),
  };
  for (const name of [decoded.pythonPathEnv, decoded.trialsRootEnv, decoded.tasksRootEnv]) {
    if (name && !process.env[name]) throw new Error(`machine path ${name} is unavailable`);
  }
  return decoded;
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
    return {
      path: text(harbor.path, 'task.config.harbor.path'),
      git_url: text(benchmark.repository, 'benchmark.config.repository'),
      git_commit_id: cell.benchmark.version,
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

async function waitForTrial(child: ChildProcess, signal?: AbortSignal): Promise<boolean> {
  const exit =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve({ code: child.exitCode, signal: child.signalCode })
      : once(child, 'exit').then(([code, childSignal]) => ({ code, signal: childSignal }));
  const cancel = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    const first = await within(exit, 20_000);
    if (first) return first.code === 0 && first.signal === null;
    child.kill('SIGTERM');
    const second = await within(exit, 20_000);
    if (second) return second.code === 0 && second.signal === null;
    child.kill('SIGKILL');
    await exit;
    return false;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
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
    Object.keys(record).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field))
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
