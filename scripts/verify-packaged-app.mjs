/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, resolve, sep } from 'node:path';
import {
  ASSET_LICENSED_RENDERER_PACKAGES,
  collectProductionClosure,
  collectWorkspaceClosure,
} from './third-party-closure.mjs';

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

export function makePtyProbe(shellFile, shellArgs, runtimeHostSetupPackage) {
  return String.raw`
const { createRequire } = require('node:module');
const requireFromApp = createRequire(process.argv[1]);
const appManifest = requireFromApp('./package.json');
const expectedRuntimeHostSetupPackage = ${JSON.stringify(runtimeHostSetupPackage)};
if (
  expectedRuntimeHostSetupPackage !== undefined &&
  appManifest.runtimeHostSetupPackage !== expectedRuntimeHostSetupPackage
) {
  console.error(
    'Packaged Runtime Host setup package mismatch: expected ' +
      expectedRuntimeHostSetupPackage +
      ', found ' +
      JSON.stringify(appManifest.runtimeHostSetupPackage),
  );
  process.exit(1);
}
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

/**
 * What `app.asar` actually carries under `node_modules`, read from the archive
 * header rather than inferred from a manifest.
 */
const desktopRoot = resolve(import.meta.dirname, '..', 'apps', 'desktop');

/** Every file path under `prefix` inside the archive, depth first. */
// Archive paths are stored `/`-joined, but `@electron/asar` resolves a lookup
// by splitting it on `path.sep`. On Windows that turns `dist/main/x.js` into a
// single name and the file is reported missing, so the lookup — and only the
// lookup — is localized before it crosses the API.
export function asarLookupPath(archivePath, separator = sep) {
  return separator === '/' ? archivePath : archivePath.split('/').join(separator);
}

function asarFilesUnder(header, prefix) {
  const root = prefix.split('/').reduce((node, part) => node?.files?.[part], header);
  const paths = [];
  const walk = (node, path) => {
    for (const [name, child] of Object.entries(node?.files ?? {})) {
      const next = `${path}/${name}`;
      if (child.files) walk(child, next);
      else paths.push(next);
    }
  };
  walk(root, prefix);
  return paths;
}

// Line-bounded on purpose: a lazy cross-line match reads the word `from`
// inside a comment as an import and reports the prose that follows it. A
// multi-line `import {` list is covered by its closing line.
const BARE_IMPORT_PATTERNS = [
  /^[ \t]*(?:import|export)[ \t]+(?:[^'"\n]*?[ \t]+from[ \t]+)?['"]([^'"\n]+)['"]/gm,
  /^[ \t]*\}[ \t]+from[ \t]+['"]([^'"\n]+)['"]/gm,
  /\b(?:import|require)\([ \t]*['"]([^'"\n]+)['"][ \t]*\)/g,
];

/** Package names the given module text imports by name, ignoring builtins. */
export function bareImportedPackages(source) {
  const names = new Set();
  for (const pattern of BARE_IMPORT_PATTERNS) {
    for (const [, specifier] of source.matchAll(pattern)) {
      if (/^[./]|^node:/.test(specifier)) continue;
      const segments = specifier.split('/');
      names.add(specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]);
    }
  }
  return names;
}

// Provided by the Electron runtime rather than the archive's node_modules, so
// they are resolvable without appearing in the packaged closure.
const RUNTIME_PROVIDED_PACKAGES = new Set(['electron']);

// Loaded on first use, not at module load. `verify-windows-harness.test.mjs`
// imports this module in the CI step that deliberately runs before `npm ci`
// ("on Node alone"), so a top-level import of a declared dependency would
// fail there even though the dependency is correctly declared.
const requirePeer = createRequire(import.meta.url);
let asarApi;
function asar() {
  asarApi ??= requirePeer('@electron/asar');
  return asarApi;
}

/**
 * Every package in the archive as `name` -> set of versions, read from each
 * package's own shipped `package.json`.
 *
 * Names alone were not enough: the closure declares exact versions, so an
 * archive carrying `react@18` against a closure that declares `react@19`
 * matched by name and passed. A version that does not appear in the closure
 * is a leak whatever it is called.
 */
function asarNodeModules(asarPath) {
  const { header } = asar().getRawHeader(asarPath);
  const names = new Map();
  const unpackedRoot = `${asarPath}.unpacked`;
  const versionOf = (node, packagePath) => {
    const manifestNode = node?.files?.['package.json'];
    if (!manifestNode) return undefined;
    try {
      // Native modules are packaged with `unpacked: true`: the header still
      // lists them, but the bytes live beside the archive in
      // `app.asar.unpacked`, where `extractFile` cannot reach them. Reading
      // the header alone would report every native module as version-less
      // and fail the identity comparison for packages that are perfectly
      // correct.
      const source = manifestNode.unpacked
        ? readFileSync(join(unpackedRoot, ...packagePath.split('/'), 'package.json'), 'utf8')
        : asar()
            .extractFile(asarPath, asarLookupPath(`${packagePath}/package.json`))
            .toString('utf8');
      const manifest = JSON.parse(source);
      return typeof manifest.version === 'string' ? manifest.version : undefined;
    } catch {
      // A package whose manifest cannot be read is reported by name with no
      // version, which fails the identity comparison rather than skipping it.
      return undefined;
    }
  };
  // Recursive: npm nests a second copy under a package when versions
  // conflict (node_modules/foo/node_modules/bar), and a walk that stops at
  // the top level would certify an archive it has not fully inspected.
  const record = (name, node, packagePath) => {
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(versionOf(node, packagePath));
  };
  const collect = (modules, prefix) => {
    for (const [name, node] of Object.entries(modules ?? {})) {
      if (name.startsWith('.')) continue; // .bin, .package-lock.json
      if (name.startsWith('@')) {
        for (const [scoped, scopedNode] of Object.entries(node.files ?? {})) {
          const path = `${prefix}/${name}/${scoped}`;
          record(`${name}/${scoped}`, scopedNode, path);
          collect(scopedNode.files?.node_modules?.files, `${path}/node_modules`);
        }
      } else {
        const path = `${prefix}/${name}`;
        record(name, node, path);
        collect(node.files?.node_modules?.files, `${path}/node_modules`);
      }
    }
  };
  collect(header.files?.node_modules?.files, 'node_modules');
  return names;
}

/**
 * The packaged archive is the only thing that can answer this. A manifest
 * assertion would still pass if electron-builder changed how it walks the
 * closure, if a transitive package leaked back in, or if the renderer stopped
 * bundling one of these — none of which are visible from `package.json`.
 */
export async function assertPackagedDependencyClosure(
  resourcesPath,
  { collectClosure, collectPackagedAllowlist } = {},
) {
  const asarPath = join(resourcesPath, 'app.asar');
  const packaged = asarNodeModules(asarPath);

  // The archive may carry exactly the Node production closure — that is the
  // graph electron-builder walks. Comparing against it catches any leak, a
  // renderer-only transitive package included, not just the declared roots.
  const allowed = collectPackagedAllowlist
    ? await collectPackagedAllowlist()
    : collectProductionClosure('@maka/desktop');
  const leaked = [];
  for (const [name, versions] of packaged) {
    const permitted = allowed.get(name);
    for (const version of versions) {
      if (permitted?.has(version)) continue;
      leaked.push(version === undefined ? name : `${name}@${version}`);
    }
  }
  if (leaked.length > 0) {
    throw new Error(
      `app.asar carries packages outside the production closure: ${leaked.join(', ')}`,
    );
  }
  // The PTY stack reaches these from the main process, so their absence would
  // mean the opposite failure — a closure trimmed past what actually runs.
  for (const required of ['@xterm/headless', '@xterm/addon-unicode11']) {
    if (!packaged.has(required)) {
      throw new Error(`app.asar is missing ${required}, which the PTY stack loads`);
    }
  }

  // Validate what ships using what ships: the notice inside the artifact, not
  // the checkout copy — a package whose shipped notice is stale or empty must
  // fail here even while the source tree's copy is complete.
  const notices = await readFile(
    join(resourcesPath, 'licenses', 'npm', 'THIRD_PARTY_NOTICES.txt'),
    'utf8',
  );
  // The same closure the generator wrote the notices from — the Node
  // production closure plus everything reachable from the renderer roots —
  // so coverage is the complete shipped set, not only the declared roots.
  const closure = collectClosure
    ? await collectClosure()
    : collectWorkspaceClosure({
        workspaceName: '@maka/desktop',
        manifestPath: join(desktopRoot, 'package.json'),
      });
  const uncovered = closure
    .filter(({ name }) => !ASSET_LICENSED_RENDERER_PACKAGES.has(name))
    .filter(({ name, version }) => !notices.includes(`\nPackage: ${name}@${version}\n`))
    .map(({ name, version }) => `${name}@${version}`);
  if (uncovered.length > 0) {
    throw new Error(
      `shipped THIRD_PARTY_NOTICES.txt is missing packages the artifact ships: ${uncovered.join(', ')}`,
    );
  }
  // Asset-licensed packages (the OFL Geist fonts) carry their license as a
  // vendored file instead of an npm-notice entry; that file must ship too.
  const closureNames = new Set(closure.map(({ name }) => name));
  for (const [name, licensePath] of ASSET_LICENSED_RENDERER_PACKAGES) {
    if (!closureNames.has(name)) continue;
    await access(join(resourcesPath, licensePath)).catch(() => {
      throw new Error(`shipped license file for ${name} is missing: ${licensePath}`);
    });
  }

  // Matching node_modules against the closure proves no package leaked in or
  // was trimmed out; it says nothing about whether the shipped code can
  // resolve what it imports. A module that imports a package the archive no
  // longer carries throws ERR_MODULE_NOT_FOUND only in the packaged app, and
  // only when something loads it — a lazily loaded main module would reach a
  // user rather than a build.
  const unresolvable = new Map();
  for (const path of asarFilesUnder(asar().getRawHeader(asarPath).header, 'dist')) {
    if (!/\.(?:js|cjs|mjs)$/.test(path)) continue;
    for (const name of bareImportedPackages(
      asar().extractFile(asarPath, asarLookupPath(path)).toString('utf8'),
    )) {
      // Being in the closure is not enough — the code has to resolve at
      // runtime, and only the archive can answer that. A package that is
      // allowed but absent is exactly the ERR_MODULE_NOT_FOUND this check
      // exists to catch.
      if (packaged.has(name) || RUNTIME_PROVIDED_PACKAGES.has(name)) continue;
      if (!unresolvable.has(name)) unresolvable.set(name, path);
    }
  }
  if (unresolvable.size > 0) {
    const detail = [...unresolvable].map(([name, path]) => `${name} (${path})`).join(', ');
    throw new Error(`app.asar ships code importing packages it does not carry: ${detail}`);
  }

  // The artifact's own record of what the renderer bundle contains — written
  // by the vite build from the rollup module graph plus emitted-asset origins.
  // Every recorded package must be inside the declared closure, so a package
  // that reaches the bundle through any path fails release verification even
  // if it never appears under node_modules in the archive.
  let recordBuffer;
  try {
    recordBuffer = asar().extractFile(
      asarPath,
      asarLookupPath('dist-renderer/bundled-npm-packages.json'),
    );
  } catch {
    throw new Error('app.asar does not carry dist-renderer/bundled-npm-packages.json');
  }
  const bundled = JSON.parse(recordBuffer.toString('utf8'));
  const undeclared = bundled.filter((name) => !closureNames.has(name));
  if (undeclared.length > 0) {
    throw new Error(
      `renderer bundle carries packages outside the declared closure: ${undeclared.join(', ')}`,
    );
  }
}

export async function assertPackagedResources(
  resourcesPath,
  {
    requirePath,
    forbidPath = assertMissing,
    requireWindowsSandbox = process.platform === 'win32',
    // Current ASF artifacts must not carry Git. The Windows upgrade lane also
    // verifies a previously released installer, whose historical contract did
    // require the bundled distribution and its compliance files; keep that
    // baseline explicit instead of judging old bytes by today's absence rule.
    bundledGitContract = 'forbidden',
    // The upgrade-lifecycle check runs this against a previously released
    // build, which predates the disclaimer being packaged. Requiring it there
    // would fail a release that was correct when it shipped.
    requireDisclaimer = true,
  } = {},
) {
  if (bundledGitContract !== 'forbidden' && bundledGitContract !== 'legacy-required') {
    throw new Error(`Unknown bundled Git artifact contract: ${bundledGitContract}`);
  }
  const requiresLegacyBundledGit = bundledGitContract === 'legacy-required';
  const required = [
    'app.asar',
    'bundled-tools.json',
    ...(requiresLegacyBundledGit
      ? [
          'bundled-git.json',
          join('licenses', 'git', 'LICENSE.txt'),
          join('licenses', 'git', 'SOURCE_OFFER.txt'),
          join('licenses', 'dugite', 'LICENSE'),
          join('licenses', 'git', 'NOTICE.txt'),
        ]
      : []),
    join('workers', 'filesystem-worker.js'),
    join('licenses', 'maka', 'LICENSE'),
    join('licenses', 'maka', 'NOTICE'),
    ...(requireDisclaimer ? [join('licenses', 'maka', 'DISCLAIMER-WIP')] : []),
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
    ...(requiresLegacyBundledGit
      ? []
      : ['git', 'bundled-git.json', join('licenses', 'dugite'), join('licenses', 'git')]),
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
