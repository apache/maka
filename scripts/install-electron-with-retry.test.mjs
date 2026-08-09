import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  electronInstallerSpawnOptions,
  installWithRetry,
  isTransientElectronInstallFailure,
} from './install-electron-with-retry.mjs';

const require = createRequire(import.meta.url);
const { contextAwareFetch, findErrorCode } = require('./run-electron-installer.cjs');
const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function fetchContext(code) {
  return JSON.stringify({ kind: 'fetch', code });
}

function httpContext(status) {
  return JSON.stringify({ kind: 'http', status });
}

test('classifies transport and retryable HTTP failures as transient', () => {
  assert.equal(isTransientElectronInstallFailure(fetchContext('ETIMEDOUT')), true);
  assert.equal(isTransientElectronInstallFailure(fetchContext('UND_ERR_SOCKET')), true);
  assert.equal(isTransientElectronInstallFailure(httpContext(503)), true);
  assert.equal(isTransientElectronInstallFailure(httpContext(404)), false);
});

test('does not trust unstructured errors or permanent failure markers', () => {
  assert.equal(isTransientElectronInstallFailure('TypeError: fetch failed'), false);
  assert.equal(isTransientElectronInstallFailure('cause: ETIMEDOUT'), false);
  assert.equal(isTransientElectronInstallFailure(fetchContext('CERT_HAS_EXPIRED')), false);
  assert.equal(
    isTransientElectronInstallFailure(fetchContext('ERR_TLS_CERT_ALTNAME_INVALID')),
    false,
  );
  assert.equal(isTransientElectronInstallFailure(fetchContext('ENOTFOUND')), false);
  assert.equal(isTransientElectronInstallFailure(httpContext(501)), false);
  assert.equal(isTransientElectronInstallFailure(JSON.stringify({ kind: 'fetch' })), false);
  assert.equal(isTransientElectronInstallFailure('not-json'), false);
});

test('captures only a safe code from a nested fetch error', () => {
  const error = new TypeError('fetch failed', {
    cause: Object.assign(new Error('certificate details and private URL'), {
      code: 'CERT_HAS_EXPIRED',
    }),
  });

  assert.equal(findErrorCode(error), 'CERT_HAS_EXPIRED');
  assert.equal(findErrorCode({ code: 'unsafe code https://secret.invalid/?token=x' }), undefined);
});

test('fetch wrapper emits sanitized context without URLs or error messages', async () => {
  const emitted = [];
  const privateUrl = 'https://user:secret@example.invalid/electron.zip?token=private';
  const wrappedFetch = contextAwareFetch(
    async () => {
      throw new TypeError(`fetch failed for ${privateUrl}`, {
        cause: Object.assign(new Error(`connect ${privateUrl}`), { code: 'ETIMEDOUT' }),
      });
    },
    (context) => emitted.push(context),
  );

  await assert.rejects(wrappedFetch(privateUrl), /fetch failed/);
  assert.deepEqual(emitted, [{ kind: 'fetch', code: 'ETIMEDOUT' }]);
  assert.equal(JSON.stringify(emitted[0]).includes('secret'), false);
  assert.equal(JSON.stringify(emitted[0]).includes('token'), false);
});

test('fetch wrapper records retryable HTTP status without the response URL', async () => {
  const emitted = [];
  const response = { ok: false, status: 503 };
  const wrappedFetch = contextAwareFetch(
    async () => response,
    (context) => emitted.push(context),
  );

  assert.equal(await wrappedFetch('https://example.invalid/private?token=x'), response);
  assert.deepEqual(emitted, [{ kind: 'http', status: 503 }]);
});

test('launcher sends HTTP context over the private fd without writing it to stderr', (t) => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'electron-installer-context-'));
  t.after(() => rmSync(fixtureDirectory, { force: true, recursive: true }));
  const fixture = join(fixtureDirectory, 'http-503.cjs');
  writeFileSync(
    fixture,
    `const http = require('node:http');
const server = http.createServer((_request, response) => {
  response.writeHead(503);
  response.end('unavailable');
});
server.listen(0, '127.0.0.1', async () => {
  try {
    const { port } = server.address();
    await fetch(\`http://127.0.0.1:\${port}/private?token=secret\`);
  } finally {
    server.close();
  }
});
`,
  );

  const child = spawnSync(
    process.execPath,
    [join(scriptDirectory, 'run-electron-installer.cjs'), fixture],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'] },
  );

  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.equal(child.output[3].trim(), httpContext(503));
  assert.equal(child.output[3].includes('token'), false);
  assert.equal(child.output[3].includes('secret'), false);
});

test('installer spawn options inherit the caller environment without forcing DEBUG', () => {
  const options = electronInstallerSpawnOptions('/repo');

  assert.equal(Object.hasOwn(options, 'env'), false);
  assert.deepEqual(options.stdio, ['inherit', 'inherit', 'pipe', 'pipe']);
});

test('retries transient failures with bounded exponential backoff', async () => {
  const attempts = [];
  const delays = [];
  const warnings = [];

  const result = await installWithRetry(
    async (attempt) => {
      attempts.push(attempt);
      return attempt < 3
        ? { status: 1, context: fetchContext('ETIMEDOUT'), stderr: 'TypeError: fetch failed' }
        : { status: 0, context: '', stderr: '' };
    },
    {
      wait: async (delay) => delays.push(delay),
      warn: (message) => warnings.push(message),
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.equal(warnings.length, 2);
});

test('does not retry permanent failures', async () => {
  let attempts = 0;
  const result = await installWithRetry(async () => {
    attempts += 1;
    return { status: 1, context: httpContext(404), stderr: 'HTTPError' };
  });

  assert.equal(result.status, 1);
  assert.equal(attempts, 1);
});

test('never classifies transient-looking stderr without structured context', async () => {
  let attempts = 0;
  const result = await installWithRetry(async () => {
    attempts += 1;
    return {
      status: 1,
      context: '',
      stderr: 'ECONNRESET https://user:secret@example.invalid/file?token=private',
    };
  });

  assert.equal(result.status, 1);
  assert.equal(attempts, 1);
});

test('stops after the configured number of attempts', async () => {
  let attempts = 0;
  const result = await installWithRetry(
    async () => {
      attempts += 1;
      return { status: 1, context: fetchContext('ECONNRESET'), stderr: 'fetch failed' };
    },
    { maxAttempts: 2, baseDelayMs: 0, wait: async () => {}, warn: () => {} },
  );

  assert.equal(result.status, 1);
  assert.equal(attempts, 2);
});

test('returns a signal termination unchanged without retrying', async () => {
  let attempts = 0;
  const result = await installWithRetry(async () => {
    attempts += 1;
    return {
      status: null,
      signal: 'SIGTERM',
      context: fetchContext('ECONNRESET'),
      stderr: 'fetch failed',
    };
  });

  assert.equal(attempts, 1);
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
});

test('returns a spawn error unchanged without retrying', async () => {
  let attempts = 0;
  const result = await installWithRetry(async () => {
    attempts += 1;
    return {
      status: null,
      spawnError: true,
      context: fetchContext('ETIMEDOUT'),
      stderr: 'spawn failed',
    };
  });

  assert.equal(attempts, 1);
  assert.equal(result.spawnError, true);
});

test('does not retry when the child has no numeric exit status', async () => {
  let attempts = 0;
  const result = await installWithRetry(async () => {
    attempts += 1;
    return {
      status: null,
      context: fetchContext('ETIMEDOUT'),
      stderr: 'fetch failed',
    };
  });

  assert.equal(attempts, 1);
  assert.equal(result.status, null);
});
