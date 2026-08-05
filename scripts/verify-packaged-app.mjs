import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';

// `timeoutMs` is opt-in, for the commands that have actually hung: node-pty
// under conpty keeps a handle open after its child exits. Everything else runs
// unbounded on purpose — codesign and notarization assessment on a full app
// bundle have no honest upper bound, and a wrong deadline fails a good release.
// The workflow timeout is the outer bound; the verifier's stage log says where.
export function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const deadline =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill('SIGKILL');
            reject(
              new Error(
                `${command} ${args.join(' ')} did not finish within ${options.timeoutMs}ms` +
                  `${stdout.trim() ? `\nstdout: ${stdout.trim()}` : ''}` +
                  `${stderr.trim() ? `\nstderr: ${stderr.trim()}` : ''}`,
              ),
            );
          }, options.timeoutMs);
    const settle = (finish) => (value) => {
      if (deadline) clearTimeout(deadline);
      finish(value);
    };
    resolvePromise = settle(resolvePromise);
    reject = settle(reject);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    if (options.input !== undefined) child.stdin.end(options.input);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} failed with ${
            signal ? `signal ${signal}` : `exit code ${code}`
          }\n${stderr.trim()}`,
        ),
      );
    });
  });
}

export async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Forbidden release resource exists: ${path}`);
}

async function reserveTcpPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a CDP port.');
  }
  await new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return address.port;
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function findRendererTarget(port, child) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged Maka exited before its renderer was ready.`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(
          (target) => target.type === 'page' && target.webSocketDebuggerUrl,
        );
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Packaged Maka renderer did not expose CDP within 30 seconds${
      lastError ? `: ${lastError.message}` : ''
    }.`,
  );
}

async function evaluateRenderer(webSocketDebuggerUrl) {
  if (typeof WebSocket !== 'function') {
    throw new Error('The release verifier requires Node.js WebSocket support.');
  }
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  try {
    return await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('CDP renderer evaluation timed out.'));
      }, 10_000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.error) {
          reject(new Error(message.error.message));
          return;
        }
        resolvePromise(message.result?.result?.value);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: `({
              readyState: document.readyState,
              hasBridge: Boolean(window.maka),
              hasRoot: Boolean(document.querySelector('#root')),
              hasPreloadSkeleton: Boolean(document.querySelector('#root > .maka-preload')),
              hasAppShell: Boolean(document.querySelector('#root [data-agents-page]'))
            })`,
            returnByValue: true,
          },
        }),
      );
    });
  } finally {
    socket.close();
  }
}

function isPackagedRendererUsable(rendererState) {
  return (
    rendererState?.readyState === 'complete' &&
    rendererState.hasBridge === true &&
    rendererState.hasRoot === true &&
    rendererState.hasPreloadSkeleton === false &&
    rendererState.hasAppShell === true
  );
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once('exit', () => resolvePromise(true))),
    delay(5_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
  }
}

export function makePtyProbe(shellFile, shellArgs) {
  return String.raw`
const { createRequire } = require('node:module');
const requireFromApp = createRequire(process.argv[1]);
const pty = requireFromApp('node-pty');
const child = pty.spawn(${JSON.stringify(shellFile)}, ${JSON.stringify(shellArgs)}, {
  name: 'xterm-color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env,
});
let output = '';
const timeout = setTimeout(() => {
  console.error('node-pty packaged smoke timed out');
  process.exit(1);
}, 5000);
child.onData((data) => {
  output += data;
});
child.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  const ok = exitCode === 0 && output.includes('maka-node-pty-ok');
  // conpty keeps a handle open after its child exits, so on Windows this process
  // never ends on its own and the probe would hang instead of report. Writing
  // through the callback exits only once the output has been flushed.
  const stream = ok ? process.stdout : process.stderr;
  const message = ok ? 'maka-node-pty-ok' : 'node-pty packaged smoke failed';
  stream.write(message + '\n', () => process.exit(ok ? 0 : 1));
});
`;
}

// A packaged app is verified against the user state of whoever runs the
// verifier, so every probe gets its own home. The macOS and Windows variables
// are set together because Electron and Node read different ones per platform
// and setting the unused ones is inert.
export function isolatedUserEnv(homeDirectory, { temporaryDirectory = homeDirectory } = {}) {
  return {
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    APPDATA: join(homeDirectory, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(homeDirectory, 'AppData', 'Local'),
    TMPDIR: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
  };
}

export async function smokePackagedRenderer(executable, { workingDirectory } = {}) {
  const port = await reserveTcpPort();
  const home = join(workingDirectory, 'home');
  const userData = join(workingDirectory, 'user-data');
  const userEnv = isolatedUserEnv(home);
  await mkdir(home, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(userEnv.APPDATA, { recursive: true });
  await mkdir(userEnv.LOCALAPPDATA, { recursive: true });
  const child = spawn(
    executable,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, '--enable-logging=stderr'],
    {
      cwd: workingDirectory,
      env: {
        ...process.env,
        MAKA_SKIP_SHELL_ENV: '1',
        ...userEnv,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });

  try {
    const target = await findRendererTarget(port, child);
    const deadline = Date.now() + 30_000;
    let rendererState;
    while (Date.now() < deadline) {
      rendererState = await evaluateRenderer(target.webSocketDebuggerUrl);
      if (isPackagedRendererUsable(rendererState)) {
        return;
      }
      if (child.exitCode !== null) {
        throw new Error('Packaged Maka exited before React mounted.');
      }
      await delay(250);
    }
    throw new Error(`Packaged renderer did not become usable: ${JSON.stringify(rendererState)}`);
  } catch (error) {
    throw new Error(`${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
  } finally {
    await stopChild(child);
  }
}

export async function assertPackagedResources(
  resourcesPath,
  { requirePath, forbidPath = assertMissing } = {},
) {
  const required = [
    'app.asar',
    'bundled-tools.json',
    'bundled-git.json',
    join('licenses', 'git', 'LICENSE.txt'),
    join('workers', 'filesystem-worker.js'),
    join('licenses', 'maka', 'LICENSE'),
    join('licenses', 'maka', 'NOTICE'),
    join('licenses', 'dugite', 'LICENSE'),
    join('licenses', 'git', 'NOTICE.txt'),
    join('licenses', 'electron', 'LICENSE'),
    join('licenses', 'electron', 'LICENSES.chromium.html'),
    join('licenses', 'npm', 'THIRD_PARTY_NOTICES.txt'),
    join('licenses', 'renderer', 'THIRD_PARTY_LICENSES.txt'),
    join('licenses', 'renderer', 'GEIST_LICENSE.txt'),
    join('licenses', 'renderer', 'GEIST_MONO_LICENSE.txt'),
    join('licenses', 'renderer', 'ANT_DESIGN_ICONS_LICENSE.txt'),
    join('licenses', 'renderer', 'SIMPLE_ICONS_LICENSE.md'),
    join('licenses', 'renderer', 'TDESIGN_ICONS_LICENSE.txt'),
    join('licenses', 'renderer', 'ALLOGO_LICENSE.txt'),
    join('licenses', 'renderer', 'SEMI_ICONS_LICENSE.txt'),
    join('licenses', 'renderer', 'MINGCUTE_APACHE_LICENSE.txt'),
  ];
  for (const path of required) {
    await requirePath(join(resourcesPath, path));
  }
  const forbidden = [
    join('tools', 'officecli'),
    join('licenses', 'officecli'),
    // cua-driver is gone from this repository, and these two forbids stay for the
    // same reason the officecli ones next to them do: `apps/desktop/resources/bin`
    // is gitignored, so a binary a developer prepared before this change is still
    // sitting in their tree and would be packaged without anything noticing.
    join('bin', 'cua-driver'),
    join('tools', 'cua-driver'),
    // maka-cu is built from source locally and is not signed, so it may not be in
    // a packaged build at all — an ad-hoc helper fails notarization for the whole
    // app, and `distributionReady` is false for exactly this reason.
    join('bin', 'maka-cu'),
    join('tools', 'maka-cu'),
  ];
  for (const path of forbidden) {
    await forbidPath(join(resourcesPath, path));
  }
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  const file = createReadStream(path);
  for await (const chunk of file) hash.update(chunk);
  return hash.digest('hex');
}
