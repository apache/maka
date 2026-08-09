#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const transientFailurePattern =
  /fetch failed|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|Response code (?:408|425|429|5\d\d)\b/i;

export function isTransientElectronInstallFailure(stderr) {
  return transientFailurePattern.test(stderr);
}

export async function installWithRetry(
  runAttempt,
  {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    wait = sleep,
    warn = console.warn,
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runAttempt(attempt);
    if (result.status === 0 || !isTransientElectronInstallFailure(result.stderr ?? '')) {
      return result;
    }
    if (attempt === maxAttempts) {
      return result;
    }

    const delayMs = baseDelayMs * 2 ** (attempt - 1);
    warn(
      `[install-electron] transient download failure on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms`,
    );
    await wait(delayMs);
  }

  throw new Error('Electron install retry loop ended unexpectedly');
}

function electronDebugNamespaces(existingDebug) {
  return existingDebug ? `${existingDebug},@electron/get*` : '@electron/get*';
}

async function main() {
  const require = createRequire(import.meta.url);
  const installer = require.resolve('electron/install.js');
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

  const result = await installWithRetry(() => {
    const child = spawnSync(process.execPath, [installer], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DEBUG: electronDebugNamespaces(process.env.DEBUG),
      },
      stdio: ['inherit', 'inherit', 'pipe'],
    });
    if (child.stderr) {
      process.stderr.write(child.stderr);
    }
    if (child.error) {
      const message = child.error.stack ?? child.error.message;
      process.stderr.write(`${message}\n`);
      return { status: child.status ?? 1, stderr: `${child.stderr ?? ''}\n${message}` };
    }
    return { status: child.status ?? 1, stderr: child.stderr ?? '' };
  });

  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
