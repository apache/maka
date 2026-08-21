import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_TEXT = 4_000;

export function findEvalReleaseTarball(
  releaseDirectory,
  platform = process.platform,
  arch = process.arch,
) {
  if (platform !== 'linux' || arch !== 'x64') {
    throw new Error('The real Eval release validation requires Linux x64');
  }
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

export function isolatedEnvironment(home) {
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
    if (name.startsWith('MAKA_EVAL_') || name.startsWith('GIT_')) delete environment[name];
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
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

export function createTaskFixture(root, environment, taskImage) {
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
  writeFileSync(join(taskRoot, 'environment/Dockerfile'), `FROM ${taskImage}\nWORKDIR /app\n`, {
    mode: 0o600,
  });
  const testPath = join(taskRoot, 'tests/test.sh');
  writeFileSync(testPath, '#!/bin/sh\nset -eu\nprintf "1\\n" > /logs/verifier/reward.txt\n', {
    mode: 0o700,
  });
  chmodSync(testPath, 0o700);
  run('git', ['init', '--initial-branch=main'], environment, repositoryRoot);
  run('git', ['config', 'user.name', 'Maka Release Validation'], environment, repositoryRoot);
  run(
    'git',
    ['config', 'user.email', 'release-validation@maka.invalid'],
    environment,
    repositoryRoot,
  );
  run('git', ['add', '.'], environment, repositoryRoot);
  run(
    'git',
    ['commit', '--message', 'Add deterministic release validation task'],
    environment,
    repositoryRoot,
  );
  const commit = run('git', ['rev-parse', 'HEAD'], environment, repositoryRoot).trim();
  return {
    commit,
    repository: pathToFileURL(repositoryRoot).href,
    tasksRoot: repositoryRoot,
  };
}

export function readFrameworkOutputs({ framework, invocation, outputRoot, trialsRoot }) {
  if (invocation.status !== 0) {
    throw frameworkOutputError(
      framework,
      `exited with status ${invocation.status}`,
      invocation,
      [],
      findJsonDiagnostics(trialsRoot),
    );
  }
  const attempts = findAttemptFiles(join(outputRoot, 'attempts'));
  const attemptNames = attempts.map((path) => relative(outputRoot, path).split(sep).join('/'));
  if (attempts.length !== 1) {
    throw frameworkOutputError(
      framework,
      `produced ${attempts.length} attempt files instead of one`,
      invocation,
      attemptNames,
      findJsonDiagnostics(trialsRoot),
    );
  }
  const summary = decodeJsonRecord(invocation.stdout);
  if (!summary.ok) {
    throw frameworkOutputError(
      framework,
      'produced invalid summary JSON',
      invocation,
      attemptNames,
      findJsonDiagnostics(trialsRoot),
      { summary: summary.evidence },
    );
  }
  const attempt = decodeJsonRecord(readFileSync(attempts[0], 'utf8'));
  if (!attempt.ok) {
    throw frameworkOutputError(
      framework,
      'produced invalid attempt JSON',
      invocation,
      attemptNames,
      findJsonDiagnostics(trialsRoot),
      { attempt: attempt.evidence },
    );
  }
  return { summary: summary.value, attempt: attempt.value };
}

export function findJsonDiagnostics(root, current = root, diagnostics = {}) {
  if (!existsSync(current)) return diagnostics;
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch (error) {
    const name = relative(root, current).split(sep).join('/') || '.';
    diagnostics[name] = diagnosticIoError('list', error);
    return diagnostics;
  }
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      findJsonDiagnostics(root, path, diagnostics);
      continue;
    }
    if (!['preparation-error.json', 'result.json', 'trial.log'].includes(entry.name)) continue;
    const name = relative(root, path).split(sep).join('/');
    let content;
    try {
      content = readFileSync(path, 'utf8').trim();
    } catch (error) {
      diagnostics[name] = diagnosticIoError('read', error);
      continue;
    }
    if (entry.name === 'trial.log') {
      diagnostics[name] = tail(content);
      continue;
    }
    const decoded = decodeJson(content);
    if (!decoded.ok) {
      diagnostics[name] = decoded.evidence;
      continue;
    }
    const parsed = decoded.value;
    diagnostics[name] =
      entry.name === 'result.json' && isRecord(parsed)
        ? {
            exceptionInfo: isRecord(parsed.exception_info)
              ? {
                  type: parsed.exception_info.exception_type,
                  message: tail(String(parsed.exception_info.exception_message ?? '')),
                }
              : null,
            verifierResult: parsed.verifier_result ?? null,
          }
        : parsed;
  }
  return diagnostics;
}

export function run(command, args, environment, cwd) {
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

export function runAllowingFailure(command, args, environment, cwd) {
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

function frameworkOutputError(
  framework,
  reason,
  invocation,
  attempts,
  frameworkDiagnostics,
  extra = {},
) {
  return new Error(
    `${framework} ${reason}: ${JSON.stringify({
      invocation: {
        status: invocation.status,
        stdout: tail(invocation.stdout),
        stderr: tail(invocation.stderr),
      },
      attempts,
      ...extra,
      frameworkDiagnostics,
    })}`,
  );
}

function decodeJsonRecord(content) {
  const decoded = decodeJson(content);
  if (!decoded.ok) return decoded;
  if (!isRecord(decoded.value)) {
    return {
      ok: false,
      evidence: { parseError: 'expected a JSON object', raw: tail(String(content).trim()) },
    };
  }
  return decoded;
}

function decodeJson(content) {
  const raw = String(content).trim();
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      evidence: {
        parseError: error instanceof Error ? error.message : String(error),
        raw: tail(raw),
      },
    };
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function diagnosticIoError(operation, error) {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  return { diagnosticError: { operation, code } };
}

function tail(value) {
  return String(value).slice(-MAX_DIAGNOSTIC_TEXT);
}
