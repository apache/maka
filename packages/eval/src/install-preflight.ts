import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExperimentSpec, JsonObject } from './experiment.js';
import { createHarnessPreparationEnvironment } from './harness-environment.js';

const PREFLIGHT_TIMEOUT_MS = 10_000;
const PREFLIGHT_OUTPUT_LIMIT_BYTES = 16 * 1024;
const PYTHON_FRAMEWORK_PROBE = [
  'from importlib import import_module',
  'from importlib.metadata import version',
  'import sys',
  'actual = version(sys.argv[1])',
  'if actual != sys.argv[2]:',
  '    raise SystemExit(f"installed {actual}, expected {sys.argv[2]}")',
  'import_module(f"{sys.argv[3]}.models.trial.config")',
].join('\n');

interface PreflightDependencies {
  readonly runCommand: (
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
    cwd: string,
  ) => Promise<void>;
}

export async function preflightBuiltinExecutor(
  spec: ExperimentSpec,
  specPath: string,
  dependencies: Partial<PreflightDependencies> = {},
): Promise<void> {
  if (spec.executor.kind !== 'harbor' && spec.executor.kind !== 'pier') {
    throw new Error(`unsupported executor: ${spec.executor.kind}`);
  }
  const config = spec.executor.config;
  const pythonPathEnv = configText(config, 'pythonPathEnv');
  const trialsRootEnv = configText(config, 'trialsRootEnv');
  const pythonPath = pythonCommand(pythonPathEnv, specPath);
  const trialsRoot = machinePath(trialsRootEnv);

  if (isAbsolute(pythonPath)) {
    await requirePath(pythonPath, `machine path ${pythonPathEnv}`, 'file');
    await access(pythonPath, constants.X_OK).catch(() => {
      throw new Error(`machine path ${pythonPathEnv} is not executable: ${pythonPath}`);
    });
  }
  await optionalDirectory(trialsRoot, `machine path ${trialsRootEnv}`);

  if (spec.executor.kind === 'pier') {
    const tasksRootEnv = configText(config, 'tasksRootEnv');
    await requirePath(machinePath(tasksRootEnv), `machine path ${tasksRootEnv}`, 'directory');
  }

  for (const [index, mount] of configArray(config, 'mounts').entries()) {
    const sourceEnv = configText(configObject(mount, `mounts[${index}]`), 'sourceEnv');
    await requirePath(machinePath(sourceEnv), `machine path ${sourceEnv}`, 'any');
  }

  const egressProxy = config.egressProxy;
  if (egressProxy !== undefined) {
    const proxy = configObject(egressProxy, 'egressProxy');
    const sourceEnv = configText(proxy, 'composeSourceEnv');
    const source = machinePath(sourceEnv);
    await requirePath(source, `machine path ${sourceEnv}`, 'directory');
    await requirePath(
      resolve(source, configText(proxy, 'composeRelativePath')),
      'Eval egress Compose overlay',
      'file',
    );
    await requirePath(
      resolve(source, configText(proxy, 'networkPolicyRelativePath')),
      'Eval egress network policy',
      'file',
    );
  }

  const relayRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../harbor');
  for (const asset of ['eval_framework.py', 'relay_agent.py', 'run_trial.py']) {
    await requirePath(resolve(relayRoot, asset), `bundled Eval runtime ${asset}`, 'file');
  }

  const runCommand = dependencies.runCommand ?? runCheckedCommand;
  const preparationEnvironment = configArray(config, 'preparationEnvironment').map((value, index) =>
    configValueText(value, `preparationEnvironment[${index}]`),
  );
  const environment = createHarnessPreparationEnvironment(
    relayRoot,
    spec.subjects.flatMap((subject) => subject.credentials),
    preparationEnvironment,
  );
  const workingDirectory = dirname(specPath);
  const frameworkVersion = configText(config, 'frameworkVersion');
  const distribution = spec.executor.kind === 'harbor' ? 'harbor' : 'datacurve-pier';
  try {
    await runCommand(
      pythonPath,
      ['-c', PYTHON_FRAMEWORK_PROBE, distribution, frameworkVersion, spec.executor.kind],
      environment,
      workingDirectory,
    );
  } catch (error) {
    throw new Error(
      `${spec.executor.kind} Python environment ${pythonPathEnv} is unavailable or does not provide ${distribution}@${frameworkVersion}: ${errorMessage(error)}`,
    );
  }

  if (configObject(config.environment, 'environment').type === 'docker') {
    try {
      await runCommand(
        'docker',
        ['version', '--format', '{{.Server.Version}}'],
        environment,
        workingDirectory,
      );
    } catch (error) {
      throw new Error(`Docker daemon is unavailable: ${errorMessage(error)}`);
    }
  }
}

async function runCheckedCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      command,
      [...args],
      {
        env: environment,
        cwd,
        timeout: PREFLIGHT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: PREFLIGHT_OUTPUT_LIMIT_BYTES,
        encoding: 'utf8',
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolvePromise();
          return;
        }
        rejectPromise(new Error(stderr.trim() || error.message));
      },
    );
  });
}

async function requirePath(
  path: string,
  label: string,
  expected: 'any' | 'file' | 'directory',
): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw new Error(`${label} is inaccessible: ${path}: ${errorMessage(error)}`);
  }
  if (expected === 'file' && !metadata.isFile()) throw new Error(`${label} is not a file: ${path}`);
  if (expected === 'directory' && !metadata.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

async function optionalDirectory(path: string, label: string): Promise<void> {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function machinePath(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`machine path ${name} is unavailable`);
  return resolve(value);
}

function pythonCommand(name: string, specPath: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`machine path ${name} is unavailable`);
  if (isAbsolute(value)) return value;
  return value.includes('/') || value.includes('\\') ? resolve(dirname(specPath), value) : value;
}

function configObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`executor.config.${label} must be an object`);
  }
  return value as JsonObject;
}

function configText(config: JsonObject, field: string): string {
  return configValueText(config[field], field);
}

function configValueText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`executor.config.${field} is required`);
  }
  return value;
}

function configArray(config: JsonObject, field: string): readonly unknown[] {
  const value = config[field];
  if (!Array.isArray(value)) throw new Error(`executor.config.${field} must be an array`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
