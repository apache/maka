import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { npmSpawnOptions } from './npm-spawn.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const cliVersion = JSON.parse(
  readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'),
).version;
const tarballPath = resolve(
  process.argv[2] ?? join(repoRoot, `packages/cli/release/maka-agent-${cliVersion}.tgz`),
);
if (!existsSync(tarballPath)) {
  throw new Error(`Release tarball does not exist: ${tarballPath}`);
}

const root = mkdtempSync(join(tmpdir(), 'maka-cli-tarball-smoke-'));
try {
  const prefix = join(root, 'prefix');
  const cache = join(root, 'empty-npm-cache');
  const home = join(root, 'home');
  execFileSync(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      prefix,
      '--cache',
      cache,
      '--offline',
      '--no-audit',
      '--no-fund',
      tarballPath,
    ],
    npmSpawnOptions({ cwd: root, stdio: 'inherit' }),
  );

  const packageRoot =
    process.platform === 'win32'
      ? join(prefix, 'node_modules/maka-agent')
      : join(prefix, 'lib/node_modules/maka-agent');
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
  };
  const maka = process.platform === 'win32' ? join(prefix, 'maka.cmd') : join(prefix, 'bin/maka');
  const makaAgent =
    process.platform === 'win32' ? join(prefix, 'maka-agent.cmd') : join(prefix, 'bin/maka-agent');
  const version = run(maka, ['--version'], environment).trim();
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (version !== manifest.version) {
    throw new Error(`Installed CLI reports ${version}; package manifest is ${manifest.version}`);
  }
  assertOutput(run(maka, ['--help'], environment), 'Usage: maka');
  assertOutput(run(makaAgent, ['--help'], environment), 'Usage: maka');
  assertOutput(run(maka, ['eval', '--help'], environment), 'usage: maka eval run');
  const nodePtyUrl = pathToFileURL(join(packageRoot, 'node_modules/node-pty/lib/index.js')).href;
  assertOutput(
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          const { spawn } = await import(${JSON.stringify(nodePtyUrl)});
          const terminal = spawn(process.execPath, ['-e', 'process.stdout.write("maka-pty-ok")']);
          let output = '';
          terminal.onData((chunk) => { output += chunk; });
          await new Promise((resolve) => terminal.onExit(resolve));
          process.stdout.write(output);
        `,
      ],
      environment,
    ),
    'maka-pty-ok',
  );
  const fsNativeUrl = pathToFileURL(
    join(packageRoot, 'node_modules/fs-native-extensions/index.js'),
  ).href;
  assertOutput(
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          const native = await import(${JSON.stringify(fsNativeUrl)});
          if (typeof native.default?.tryLock !== 'function') process.exit(1);
          process.stdout.write('maka-fs-native-ok');
        `,
      ],
      environment,
    ),
    'maka-fs-native-ok',
  );

  for (const path of [
    'node_modules/@maka/runtime/dist/workers/filesystem-worker.js',
    'node_modules/@maka/runtime-host/dist/execution-candidate-main.js',
    'node_modules/@maka/eval/dist/index.js',
    'packages/eval/harbor/relay_agent.py',
    'packages/eval/harbor/egress-proxy/network-policy',
  ]) {
    if (!existsSync(join(packageRoot, path)))
      throw new Error(`Installed runtime file is missing: ${path}`);
  }
  assertOutput(
    readFileSync(join(packageRoot, 'node_modules/node-pty/lib/unixTerminal.js'), 'utf8'),
    'CustomWriteStream.prototype._ownsFileDescriptor',
  );
  assertOutput(
    readFileSync(join(packageRoot, 'node_modules/@ai-sdk/provider-utils/dist/index.js'), 'utf8'),
    'function absentIfBlank',
  );

  console.log(`[release-cli-smoke] OK — installed ${basename(tarballPath)} offline as ${version}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

function run(command, args, env) {
  return execFileSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === 'win32' && command.toLowerCase().endsWith('.cmd'),
  });
}

function assertOutput(output, marker) {
  if (!output.includes(marker))
    throw new Error(`Expected output to contain ${JSON.stringify(marker)}`);
}
