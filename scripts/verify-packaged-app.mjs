import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, readdir } from 'node:fs/promises';
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

/**
 * The authoritative CDP port: Chromium announces it on stderr once the
 * DevTools socket is actually bound. Callers spawn with
 * `--remote-debugging-port=0` and wait for this instead of pre-reserving a
 * port — reserve-then-release had a race window in which another process
 * could take the port, leaving Electron listening elsewhere while the
 * verifier polled the stale number for its full deadline ("did not expose
 * CDP ... fetch failed", observed repeatedly on busy CI runners).
 */
export function waitForDevToolsPort(child, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const cleanup = () => {
      clearTimeout(timeout);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Packaged Maka did not announce a DevTools port within ${timeoutMs}ms.` +
            `${buffer.trim() ? `\n${buffer.trim()}` : ''}`,
        ),
      );
    }, timeoutMs);
    const onData = (chunk) => {
      buffer = `${buffer}${chunk}`.slice(-16_384);
      const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(buffer);
      if (match) {
        cleanup();
        resolvePromise(Number(match[1]));
      }
    };
    const onExit = () => {
      cleanup();
      reject(
        new Error(
          `Packaged Maka exited before announcing a DevTools port.` +
            `${buffer.trim() ? `\n${buffer.trim()}` : ''}`,
        ),
      );
    };
    child.stderr.on('data', onData);
    child.once('exit', onExit);
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

// The default deadline is generous on purpose: windows-2025 runners have shown
// first-page creation taking beyond 30 seconds when a smoke follows multiple
// installs in the same job, and a too-tight deadline fails a good build. The
// wait is still bounded and fail-closed; a dead child short-circuits it.
export async function findRendererTarget(port, child, { timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged Maka exited before its renderer was ready.`);
    }
    try {
      // A connect that hangs (half-open or filtered socket) would otherwise
      // run into the OS connect timeout and overshoot the stated deadline by
      // minutes — observed as a ~6-minute "90 seconds" failure on CI.
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
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
  // `fetch failed` alone says nothing; the cause chain carries the socket
  // errno (ECONNREFUSED vs ETIMEDOUT vs ECONNRESET), which is the evidence
  // that distinguishes "DevTools never listened" from "something filtered it".
  const described = [];
  for (let error = lastError; error; error = error.cause) {
    if (Array.isArray(error.errors) && error.errors.length) {
      described.push(error.errors.map((inner) => inner.message ?? String(inner)).join(' & '));
    } else {
      described.push(error.message ?? String(error));
    }
  }
  throw new Error(
    `Packaged Maka renderer did not expose CDP within ${Math.round(timeoutMs / 1000)} seconds${
      described.length ? `: ${described.join(' <- ')}` : ''
    }.`,
  );
}

/**
 * Evaluate one expression in a renderer over CDP and return its
 * `returnByValue` result. `awaitPromise` resolves a returned promise before
 * reporting, which is how the auto-update harness drives `window.maka.app`
 * calls; the plain smoke below keeps its original synchronous expression.
 */
export async function evaluateInRenderer(
  webSocketDebuggerUrl,
  expression,
  { awaitPromise = false, timeoutMs = 10_000 } = {},
) {
  if (typeof WebSocket !== 'function') {
    throw new Error('The release verifier requires Node.js WebSocket support.');
  }
  const socket = new WebSocket(webSocketDebuggerUrl);
  try {
    // The handshake needs its own bound: a DevTools port that accepts TCP
    // but never speaks raises neither `open` nor `error`, and an unbounded
    // await here would make every retry loop built on this helper hang to
    // the workflow timeout instead of failing one probe.
    await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`CDP WebSocket did not open within ${timeoutMs}ms.`));
      }, timeoutMs);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timeout);
          resolvePromise();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        (event) => {
          clearTimeout(timeout);
          reject(event.error ?? new Error('CDP WebSocket connection failed.'));
        },
        { once: true },
      );
    });
  } catch (error) {
    socket.close();
    throw error;
  }

  try {
    return await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('CDP renderer evaluation timed out.'));
      }, timeoutMs);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        clearTimeout(timeout);
        if (message.error) {
          reject(new Error(message.error.message));
          return;
        }
        if (message.result?.exceptionDetails) {
          reject(
            new Error(
              message.result.exceptionDetails.exception?.description ??
                message.result.exceptionDetails.text ??
                'Renderer evaluation threw.',
            ),
          );
          return;
        }
        resolvePromise(message.result?.result?.value);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression,
            returnByValue: true,
            awaitPromise,
          },
        }),
      );
    });
  } finally {
    socket.close();
  }
}

export const RENDERER_STATE_EXPRESSION = `({
  readyState: document.readyState,
  hasBridge: Boolean(window.maka),
  hasRoot: Boolean(document.querySelector('#root')),
  hasPreloadSkeleton: Boolean(document.querySelector('#root > .maka-preload')),
  hasAppShell: Boolean(document.querySelector('#root [data-agents-page]'))
})`;

function evaluateRenderer(webSocketDebuggerUrl, timeoutMs) {
  return evaluateInRenderer(webSocketDebuggerUrl, RENDERER_STATE_EXPRESSION, { timeoutMs });
}

export function isPackagedRendererUsable(rendererState) {
  return (
    rendererState?.readyState === 'complete' &&
    rendererState.hasBridge === true &&
    rendererState.hasRoot === true &&
    rendererState.hasPreloadSkeleton === false &&
    rendererState.hasAppShell === true
  );
}

/**
 * Poll a freshly booted packaged app over CDP until its renderer reports the
 * usable state. One evaluation can stall past its own socket timeout while
 * the renderer is still booting — observed on the Windows release runners,
 * where a single timed-out `Runtime.evaluate` used to fail the whole gate.
 * The deadline here is the authority: an individual failed probe is retried,
 * not fatal, and only the deadline (or child exit) fails the wait. The last
 * probe error or renderer state is reported as evidence either way.
 */
export async function waitForUsableRenderer(
  webSocketDebuggerUrl,
  child,
  { deadlineMs = 30_000, description = 'Packaged renderer' } = {},
) {
  const deadline = Date.now() + deadlineMs;
  let state;
  let lastError;
  for (;;) {
    try {
      state = await evaluateRenderer(
        webSocketDebuggerUrl,
        Math.max(1, Math.min(10_000, deadline - Date.now())),
      );
      lastError = undefined;
      if (isPackagedRendererUsable(state)) return;
    } catch (error) {
      lastError = error;
    }
    if (child.exitCode !== null) {
      throw new Error(`${description} exited before it became usable.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${description} did not become usable within ${deadlineMs}ms: ${
          lastError ? lastError.message : JSON.stringify(state)
        }`,
      );
    }
    await delay(250);
  }
}

export async function stopChild(child) {
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
  const home = join(workingDirectory, 'home');
  const userData = join(workingDirectory, 'user-data');
  const userEnv = isolatedUserEnv(home);
  await mkdir(home, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(userEnv.APPDATA, { recursive: true });
  await mkdir(userEnv.LOCALAPPDATA, { recursive: true });
  const child = spawn(
    executable,
    ['--remote-debugging-port=0', `--user-data-dir=${userData}`, '--enable-logging=stderr'],
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
    const port = await waitForDevToolsPort(child);
    const target = await findRendererTarget(port, child);
    await waitForUsableRenderer(target.webSocketDebuggerUrl, child);
  } catch (error) {
    throw new Error(`${error.message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
  } finally {
    await stopChild(child);
  }
}

export async function assertPackagedResources(
  resourcesPath,
  {
    requirePath,
    forbidPath = assertMissing,
    requireWindowsSandbox = process.platform === 'win32',
    // The upgrade-lifecycle check runs this against a previously released
    // build, which predates the disclaimer being packaged. Requiring it there
    // would fail a release that was correct when it shipped.
    requireDisclaimer = true,
  } = {},
) {
  const required = [
    'app.asar',
    'bundled-tools.json',
    'bundled-git.json',
    join('licenses', 'git', 'LICENSE.txt'),
    join('licenses', 'git', 'SOURCE_OFFER.txt'),
    join('workers', 'filesystem-worker.js'),
    join('licenses', 'maka', 'LICENSE'),
    join('licenses', 'maka', 'NOTICE'),
    ...(requireDisclaimer ? [join('licenses', 'maka', 'DISCLAIMER-WIP')] : []),
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
    ...(requireWindowsSandbox
      ? [
          join('windows-sandbox', 'maka-windows-sandbox.exe'),
          join('licenses', 'cargo', 'THIRD_PARTY_NOTICES.txt'),
        ]
      : []),
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

/**
 * Recursive content manifest of a directory tree: POSIX-normalized relative
 * paths, sorted, each with its file's SHA-256. Nothing is skipped — an install
 * tree has no entries whose drift would be acceptable — and anything that is
 * not a plain file or directory (symlinks, junctions, devices) throws: an
 * install tree must not contain them, and silently hashing a link target would
 * make two different trees compare equal.
 */
export async function directoryTreeManifest(rootDirectory) {
  const entries = [];
  const walk = async (directory, prefix) => {
    const children = await readdir(directory, { withFileTypes: true });
    // Empty directories are recorded (trailing slash, null hash) so a
    // restore that loses one shows up as `missing` — files alone cannot
    // witness an empty directory.
    if (children.length === 0 && prefix !== '') {
      entries.push({ path: `${prefix}/`, sha256: null });
      return;
    }
    for (const child of children) {
      const absolute = join(directory, child.name);
      const relative = prefix === '' ? child.name : `${prefix}/${child.name}`;
      if (child.isDirectory()) {
        await walk(absolute, relative);
      } else if (child.isFile()) {
        entries.push({ path: relative, sha256: await sha256File(absolute) });
      } else {
        throw new Error(`Unsupported directory entry in ${rootDirectory}: ${relative}`);
      }
    }
  };
  await walk(rootDirectory, '');
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return entries;
}

/** Difference between two directoryTreeManifest results, keyed by path. */
export function diffTreeManifests(before, after) {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry.sha256]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry.sha256]));
  const missing = before.filter((entry) => !afterByPath.has(entry.path)).map((entry) => entry.path);
  const extra = after.filter((entry) => !beforeByPath.has(entry.path)).map((entry) => entry.path);
  const changed = before
    .filter((entry) => afterByPath.has(entry.path) && afterByPath.get(entry.path) !== entry.sha256)
    .map((entry) => entry.path);
  return { missing, extra, changed };
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  const file = createReadStream(path);
  for await (const chunk of file) hash.update(chunk);
  return hash.digest('hex');
}
