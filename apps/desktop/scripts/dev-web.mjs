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

/**
 * `maka-web` launcher: open the Maka renderer in system Chrome/Brave.
 *
 * Shares the vite dev server with `maka-gui` when it is already running
 * (both at the same time is supported): probes :5173 first and only starts
 * a second vite instance when nothing answers. Also starts the tiny local
 * `maka-web` API (path validation for the typed directory picker) and opens
 * the system browser — never Electron — to the renderer URL.
 *
 * Usage:
 *   node scripts/dev-web.mjs [--project /path/to/dir] [--no-open]
 *                            [--vite-url http://localhost:5173] [--api-port 5174]
 *                            [--host 127.0.0.1] [--port 5173]
 *
 * Remote: print `http://localhost:5173/login` and
 * `tailscale serve --bg http://127.0.0.1:5173`. Tailscale terminates HTTPS;
 * Maka stays on loopback. Do not put the bridge token in the URL.
 */
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createWebApiServer, DEFAULT_WEB_API_PORT } from './maka-web-api.mjs';

const DESKTOP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function log(label, msg) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false})}][${label}] ${msg}`);
}

function argValue(argv, name, fallback) {
  const flag = `--${name}`;
  const idx = argv.indexOf(flag);
  if (idx === -1) return fallback;
  const next = argv[idx + 1];
  if (!next || next.startsWith('--')) return fallback;
  return next;
}

async function probe(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the GUI-written bridge token file (see main/web-bridge/server.ts).
 * Polls briefly: the typical order is GUI first, but `maka-web` started a few
 * seconds early should still catch it. Returns null when no GUI is around —
 * the browser then lands on the picker tier instead of failing.
 */
async function waitForBridgeFile() {
  const override = process.env.MAKA_WEB_BRIDGE_FILE?.trim();
  const file = override || join(tmpdir(), 'maka-web-bridge.json');
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (parsed?.wsUrl && parsed?.token) {
        return {
          wsUrl: parsed.wsUrl,
          token: parsed.token,
          file,
          webAccessPath: typeof parsed.webAccessPath === 'string' ? parsed.webAccessPath : '',
        };
      }
    } catch {
      // Not written yet (or unreadable) — keep polling until the deadline.
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function openInSystemBrowser(url) {  const candidates = ['brave-browser', 'google-chrome', 'chromium', 'chromium-browser'];
  for (const bin of candidates) {
    const check = spawnSync('which', [bin], { encoding: 'utf8' });
    if (check.status === 0 && check.stdout.trim()) {
      log('web', `opening ${bin} -> ${url}`);
      try {
        const child = spawn(bin, [url], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch {
        // Fall through to xdg-open below.
        break;
      }
      return bin;
    }
  }
  log('web', `no chrome/brave binary found; falling back to xdg-open -> ${url}`);
  try {
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // Last resort: the URL is already printed above for manual opening.
  }
  return 'xdg-open';
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`maka-web: open Maka in system Chrome/Brave.

Usage:
  node scripts/dev-web.mjs [--project /path/to/dir] [--no-open]
                           [--vite-url http://localhost:5173] [--api-port 5174]
                           [--host 127.0.0.1] [--port 5173]

Then open http://localhost:5173/login (prefer localhost so Chromium treats
it as a secure context). Other devices: Tailscale Serve HTTPS:

  tailscale serve --bg http://127.0.0.1:5173

Two browser tiers:
  Full client (after passphrase+TOTP): tunnels the real app over same-origin
    /bridge. The disk token never appears in the URL. Requires \`npm run maka-gui\`.
  Picker (no GUI / failed bridge): validates a typed server-local directory.

The typed directory picker is validated by the local API on 127.0.0.1 (--api-port).`);
  process.exit(0);
}
const apiPort = Number(argValue(argv, 'api-port', String(DEFAULT_WEB_API_PORT))) || DEFAULT_WEB_API_PORT;
const explicitViteUrl = argValue(argv, 'vite-url', undefined);
const initialProject = argValue(argv, 'project', undefined);
const shouldOpen = !argv.includes('--no-open');
const viteHost = argValue(argv, 'host', '127.0.0.1');
const vitePort = Number(argValue(argv, 'port', '5173')) || 5173;
const isRemoteBind = viteHost !== 'localhost' && viteHost !== '127.0.0.1' && viteHost !== '::1';

// 1. Local web API (typed directory picker backend).
const api = createWebApiServer({ port: apiPort });
try {
  await api.listen();
} catch (error) {
  const code = error?.code ? ` (${error.code})` : '';
  console.error(`[web] cannot listen on 127.0.0.1:${apiPort}${code}; pass --api-port <free-port>.`);
  process.exit(1);
}
log('web', `directory API listening on http://127.0.0.1:${apiPort} (/api/health)`);

// 2. Renderer: this process must own Vite so attachWebGateway can intercept
// /login and /bridge. `--vite-url` still points at an already-running server
// (no gateway in that case). `--host 0.0.0.0` sets allowedHosts: true.
let devUrl = explicitViteUrl;
if (devUrl && !(await probe(devUrl))) {
  console.error(`[web] --vite-url ${devUrl} is not reachable; aborting.`);
  await api.close();
  process.exit(1);
}
async function startOwnVite() {
  process.chdir(DESKTOP_DIR);
  const bindDesc = `${viteHost}:${vitePort}${isRemoteBind ? ' (remote-reachable, allowedHosts: true)' : ''}`;
  log('web', `starting vite dev server on ${bindDesc} (no Electron)...`);
  const server = await createServer({
    server: {
      host: viteHost,
      port: vitePort,
      ...(isRemoteBind ? { allowedHosts: true } : {}),
    },
  });
  await server.listen();
  server.printUrls();
  return server;
}

async function attachGateway(httpServer, bridge) {
  try {
    const { attachWebGateway } = await import('../dist/main/web-gateway/attach.js');
    const wsUrl = bridge?.wsUrl ? new URL(bridge.wsUrl) : null;
    attachWebGateway(httpServer, {
      webAccessPath: bridge?.webAccessPath || '',
      bridgeToken: bridge?.token || '',
      bridgePort: Number(wsUrl?.port) || 53217,
      secureCookies: false,
    });
    log('web', 'gateway attached (session cookie; bridge token stays on disk)');
  } catch (error) {
    const detail = error?.message ?? error;
    log('web', `gateway not attached (${detail}); start maka-gui once so dist/main exists`);
  }
}
let viteServer;
if (!devUrl) {
  const primary = `http://localhost:${vitePort}/`;
  if (!isRemoteBind && (await probe(primary))) {
    log('web', `localhost renderer already on ${primary}; starting our own so the login gateway can attach`);
  }
  viteServer = await startOwnVite();
  devUrl = viteServer.resolvedUrls?.local?.[0]?.replace(/\/$/, '') ?? `http://localhost:${vitePort}`;
  log('web', 'warming renderer entry...');
  try {
    await viteServer.environments.client.warmupRequest('/main.tsx');
    await viteServer.environments.client.waitForRequestsIdle();
  } catch {
    // Warmup is best-effort; the page still loads without it.
  }
}

const boundPort = Number(new URL(devUrl).port || vitePort) || vitePort;
const loginUrl = `http://localhost:${boundPort}/login`;
const bridge = await waitForBridgeFile();
if (viteServer?.httpServer) {
  await attachGateway(viteServer.httpServer, bridge);
} else {
  log('web', 'no local Vite http server (explicit --vite-url); gateway not attached in this process');
}
if (bridge) {
  log('web', `full client: /bridge proxied with disk token from ${bridge.file}`);
} else {
  log('web', 'no GUI bridge yet — /login still works; start `npm run maka-gui` for chat.');
}
log('web', loginUrl);
log('web', `tailscale serve --bg http://127.0.0.1:${boundPort}`);
if (initialProject) log('web', `project preselect is ignored until after login (${initialProject})`);

if (shouldOpen) openInSystemBrowser(loginUrl);
else log('web', '--no-open: browser auto-open skipped.');

const shutdown = async () => {
  await api.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
