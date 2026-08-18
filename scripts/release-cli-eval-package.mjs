import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HARBOR_VERSION = '0.20.0';
const PIER_VERSION = '0.3.0';
const TASK_IMAGE =
  'python:3.12-slim@sha256:dd29372629eeba2dd003fd9e9d35a5b8236c44727875a0364254b5127af88e65';
const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const releaseDirectory = resolve('packages/cli/release');
const tarballPath = findReleaseTarball();

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('The real Eval release validation requires Linux x64');
}

const root = mkdtempSync(join(tmpdir(), 'maka-cli-eval-validation-'));
let primaryError;
try {
  validateChecksum();
  const prefix = join(root, 'prefix');
  const environment = isolatedEnvironment(join(root, 'home'));
  logStep('installing the immutable tarball with an empty offline npm cache');
  run(
    'npm',
    [
      'install',
      '--global',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--cache',
      join(root, 'npm-cache'),
      '--prefix',
      prefix,
      tarballPath,
    ],
    environment,
    root,
  );

  const maka = join(prefix, 'bin/maka');
  const packageRoot = join(prefix, 'lib/node_modules/maka-agent');
  if (!existsSync(maka) || !existsSync(join(packageRoot, 'packages/eval/harbor/run_trial.py'))) {
    throw new Error('The installed candidate is missing its CLI or bundled Eval runtime');
  }

  const fixture = createTaskFixture(join(root, 'fixture'));
  for (const framework of ['harbor', 'pier']) {
    logStep(`running a real ${framework} Docker cell from the installed candidate`);
    validateFramework({
      environment,
      fixture,
      framework,
      maka,
      root: join(root, framework),
    });
  }
  logStep(`OK — installed ${basename(tarballPath)} completed real Harbor and Pier cells`);
} catch (error) {
  primaryError = error;
} finally {
  let cleanupError;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], 'Eval validation and cleanup failed');
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}

function validateFramework({ environment, fixture, framework, maka, root: frameworkRoot }) {
  mkdirSync(frameworkRoot, { recursive: true, mode: 0o700 });
  const outputRoot = join(frameworkRoot, 'output');
  const trialsRoot = join(frameworkRoot, 'trials');
  const pythonVariable =
    framework === 'harbor' ? 'MAKA_RELEASE_HARBOR_PYTHON' : 'MAKA_RELEASE_PIER_PYTHON';
  const pythonPath = process.env[pythonVariable];
  if (!pythonPath) throw new Error(`${pythonVariable} is required`);
  const pythonPathVariable = `MAKA_RELEASE_${framework.toUpperCase()}_PYTHON_PATH`;
  const trialsVariable = `MAKA_RELEASE_${framework.toUpperCase()}_TRIALS`;
  const tasksVariable = 'MAKA_RELEASE_PIER_TASKS';
  const specPath = join(frameworkRoot, 'experiment.json');
  const spec = experimentSpec({
    fixture,
    framework,
    pythonPathVariable,
    tasksVariable,
    trialsVariable,
  });
  writeFileSync(specPath, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
  const childEnvironment = {
    ...environment,
    [pythonPathVariable]: pythonPath,
    [trialsVariable]: trialsRoot,
    ...(framework === 'pier' ? { [tasksVariable]: fixture.tasksRoot } : {}),
  };
  const invocation = runAllowingFailure(
    maka,
    ['eval', 'run', specPath, '--out', outputRoot],
    childEnvironment,
    frameworkRoot,
  );
  const summary = JSON.parse(invocation.stdout.trim());
  const attempts = findAttemptFiles(join(outputRoot, 'attempts'));
  if (attempts.length !== 1) {
    throw new Error(`${framework} produced ${attempts.length} attempt files instead of one`);
  }
  const attempt = JSON.parse(readFileSync(attempts[0], 'utf8'));
  const result = attempt.result;
  if (
    invocation.status !== 0 ||
    summary.experimentId !== `release-${framework}` ||
    summary.cells !== 1 ||
    summary.incomplete !== 0 ||
    attempt.cellId !== 'task::1::subject' ||
    attempt.sequence !== 1 ||
    result?.status !== 'completed' ||
    result?.score !== 1 ||
    result?.usage !== null ||
    result?.costUsd !== null ||
    result?.failureReason !== null
  ) {
    throw new Error(
      `${framework} produced an invalid completed attempt: ${JSON.stringify({
        invocation,
        summary,
        attempt,
        frameworkDiagnostics: findJsonDiagnostics(trialsRoot),
      })}`,
    );
  }
  const trialArtifact = result.artifacts.find(
    (artifact) => artifact.kind === 'trial' && artifact.framework === framework,
  );
  const processArtifact = result.artifacts.find(
    (artifact) => artifact.kind === 'external_process' && artifact.exitCode === 0,
  );
  const collected = result.artifacts.filter((artifact) => artifact.kind === 'collected-artifact');
  if (!trialArtifact || !processArtifact || collected.length < 2) {
    throw new Error(`${framework} did not preserve the expected trial and subject artifacts`);
  }
  const containers = run(
    'docker',
    ['ps', '--all', '--quiet', '--filter', `name=${trialArtifact.trialName}`],
    childEnvironment,
    frameworkRoot,
  ).trim();
  if (containers) throw new Error(`${framework} left trial containers behind: ${containers}`);
}

function experimentSpec({ fixture, framework, pythonPathVariable, tasksVariable, trialsVariable }) {
  return {
    schemaVersion: 'maka.eval.v1',
    id: `release-${framework}`,
    benchmark: {
      id: 'release-validation',
      version: fixture.commit,
      config: { repository: fixture.repository },
    },
    executor: {
      kind: framework,
      config: {
        frameworkVersion: framework === 'harbor' ? HARBOR_VERSION : PIER_VERSION,
        pythonPathEnv: pythonPathVariable,
        trialsRootEnv: trialsVariable,
        ...(framework === 'pier' ? { tasksRootEnv: tasksVariable } : {}),
        environment: { type: 'docker', delete: true },
        preparationEnvironment: [],
        mounts: [],
      },
    },
    subjects: [
      {
        id: 'subject',
        kind: 'external',
        credentials: [],
        config: { command: '/bin/true', args: [], result: 'exit-code' },
      },
    ],
    tasks: [
      {
        id: 'task',
        input: 'Exit successfully without modifying the task.',
        config: framework === 'harbor' ? { harbor: { path: 'task' } } : { pier: { path: 'task' } },
      },
    ],
    repetitions: 1,
    budget: { timeoutMultiplier: 1 },
    verifier: { reward: 'reward' },
  };
}

function createTaskFixture(root) {
  const repositoryRoot = join(root, 'repository');
  const taskRoot = join(repositoryRoot, 'task');
  mkdirSync(join(taskRoot, 'environment'), { recursive: true, mode: 0o700 });
  mkdirSync(join(taskRoot, 'tests'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(taskRoot, 'task.toml'),
    [
      'version = "1.0"',
      '',
      '[metadata]',
      '',
      '[verifier]',
      'timeout_sec = 60.0',
      '',
      '[agent]',
      'timeout_sec = 60.0',
      '',
      '[environment]',
      'build_timeout_sec = 120.0',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    join(taskRoot, 'instruction.md'),
    'Exit successfully without modifying the task.\n',
    { mode: 0o600 },
  );
  writeFileSync(join(taskRoot, 'environment/Dockerfile'), `FROM ${TASK_IMAGE}\nWORKDIR /app\n`, {
    mode: 0o600,
  });
  const testPath = join(taskRoot, 'tests/test.sh');
  writeFileSync(testPath, '#!/bin/sh\nset -eu\nprintf "1\\n" > /logs/verifier/reward.txt\n', {
    mode: 0o700,
  });
  chmodSync(testPath, 0o700);
  run('git', ['init', '--initial-branch=main'], process.env, repositoryRoot);
  run('git', ['config', 'user.name', 'Maka Release Validation'], process.env, repositoryRoot);
  run(
    'git',
    ['config', 'user.email', 'release-validation@maka.invalid'],
    process.env,
    repositoryRoot,
  );
  run('git', ['add', '.'], process.env, repositoryRoot);
  run(
    'git',
    ['commit', '--message', 'Add deterministic release validation task'],
    process.env,
    repositoryRoot,
  );
  const commit = run('git', ['rev-parse', 'HEAD'], process.env, repositoryRoot).trim();
  return {
    commit,
    repository: pathToFileURL(repositoryRoot).href,
    tasksRoot: repositoryRoot,
  };
}

function findAttemptFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...findAttemptFiles(path));
    else if (/^\d{6}\.json$/u.test(entry.name)) files.push(path);
  }
  return files.sort();
}

function findJsonDiagnostics(root, current = root) {
  if (!existsSync(current)) return {};
  const diagnostics = {};
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      Object.assign(diagnostics, findJsonDiagnostics(root, path));
      continue;
    }
    if (!['preparation-error.json', 'result.json', 'trial.log'].includes(entry.name)) continue;
    const name = relative(root, path).split(sep).join('/');
    const content = readFileSync(path, 'utf8').trim();
    if (entry.name === 'trial.log') {
      diagnostics[name] = content.slice(-4_000);
      continue;
    }
    const parsed = JSON.parse(content);
    diagnostics[name] =
      entry.name === 'result.json'
        ? {
            exceptionInfo: parsed.exception_info
              ? {
                  type: parsed.exception_info.exception_type,
                  message: String(parsed.exception_info.exception_message ?? '').slice(-4_000),
                }
              : null,
            verifierResult: parsed.verifier_result ?? null,
          }
        : parsed;
  }
  return diagnostics;
}

function findReleaseTarball() {
  const tarballs = readdirSync(releaseDirectory)
    .filter((name) => /^maka-agent-[^/]+\.tgz$/u.test(name))
    .map((name) => join(releaseDirectory, name));
  if (tarballs.length !== 1) {
    throw new Error(
      `Expected one release tarball in ${releaseDirectory}, found ${tarballs.length}`,
    );
  }
  return tarballs[0];
}

function validateChecksum() {
  const checksumPath = `${tarballPath}.sha256`;
  const [expected, name, extra] = readFileSync(checksumPath, 'utf8').trim().split(/\s+/u);
  if (!expected || name !== basename(tarballPath) || extra !== undefined) {
    throw new Error(`Invalid checksum file ${checksumPath}`);
  }
  const actual = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${tarballPath}`);
}

function isolatedEnvironment(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const environment = {
    ...process.env,
    HOME: home,
    NODE_PATH: '',
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
  };
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  for (const name of Object.keys(environment)) {
    if (name.startsWith('MAKA_EVAL_')) delete environment[name];
  }
  for (const name of [
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
  ]) {
    delete environment[name];
  }
  return environment;
}

function run(command, args, environment, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      env: environment,
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stdout = String(error.stdout ?? '').trim();
    const stderr = String(error.stderr ?? '').trim();
    throw new Error(
      `${command} ${args.join(' ')} failed${stdout ? `\nstdout:\n${stdout}` : ''}${stderr ? `\nstderr:\n${stderr}` : ''}`,
      { cause: error },
    );
  }
}

function runAllowingFailure(command, args, environment, cwd) {
  try {
    return { status: 0, stdout: run(command, args, environment, cwd), stderr: '' };
  } catch (error) {
    const cause = error.cause;
    if (typeof cause?.status !== 'number') throw error;
    return {
      status: cause.status,
      stdout: String(cause.stdout ?? ''),
      stderr: String(cause.stderr ?? ''),
    };
  }
}

function logStep(message) {
  console.log(`[release-cli-eval-validation] ${message}`);
}
