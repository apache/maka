#!/usr/bin/env node
/**
 * Run the headless Node test suite without inheriting user config or credentials.
 *
 * Usage:
 *   node scripts/run-headless-tests.mjs
 *   node scripts/run-headless-tests.mjs --help
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), '..');
const headlessDir = join(repoRoot, 'packages', 'headless');
const testPattern = 'dist/**/*.test.js';

const usage = `Usage: node scripts/run-headless-tests.mjs

Runs packages/headless tests with isolated user config, credentials, proxies, and Git config.
`;

const sensitiveEnvName =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;
const proxyEnvName = /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)$/i;

export function runHeadlessTests(options = {}) {
  const cwd = options.cwd ?? headlessDir;
  const spawn = options.spawnSync ?? spawnSync;
  const inheritedEnv = options.env ?? process.env;
  const tempDir = mkdtempSync(join(tmpdir(), 'maka-headless-test-env-'));
  const credentialsPath = join(tempDir, 'credentials.json');
  const globalConfigPath = join(tempDir, 'gitconfig');
  // Unlike the XDG directories, which the code under test creates on demand,
  // this one has to exist before a test calls mkdtemp() against it.
  const tempTmpDir = join(tempDir, 'tmp');

  try {
    mkdirSync(tempTmpDir, { recursive: true });
    writeFileSync(credentialsPath, '{"version":1,"values":{}}\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    writeFileSync(globalConfigPath, '', { encoding: 'utf8', mode: 0o600 });
    const result = spawn(process.execPath, ['--test', testPattern], {
      cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(inheritedEnv).filter(
            ([name]) => !sensitiveEnvName.test(name) && !proxyEnvName.test(name),
          ),
        ),
        HOME: tempDir,
        USERPROFILE: tempDir,
        // Keeps `mkdtemp(tmpdir(), …)` inside the tree this script already
        // removes, so a direct run isolates temp state the same way the
        // workspace runner does. TMPDIR is read by os.tmpdir() on POSIX,
        // TMP/TEMP on Windows.
        TMPDIR: tempTmpDir,
        TMP: tempTmpDir,
        TEMP: tempTmpDir,
        XDG_CONFIG_HOME: join(tempDir, 'config'),
        XDG_DATA_HOME: join(tempDir, 'data'),
        XDG_STATE_HOME: join(tempDir, 'state'),
        XDG_CACHE_HOME: join(tempDir, 'cache'),
        APPDATA: join(tempDir, 'appdata'),
        MAKA_CREDENTIALS_PATH: credentialsPath,
        GIT_CONFIG_GLOBAL: globalConfigPath,
        GIT_CONFIG_NOSYSTEM: '1',
      },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    // A cleanup failure must not replace the suite's own result.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`could not remove ${tempDir}: ${error.message}`);
    }
  }
}

function main(args) {
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    process.stdout.write(usage);
    return 0;
  }
  if (args.length > 0) {
    process.stderr.write(`${usage}\nUnexpected argument: ${args[0]}\n`);
    return 2;
  }
  return runHeadlessTests();
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main(process.argv.slice(2));
}
