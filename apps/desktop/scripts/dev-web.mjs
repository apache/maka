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
 * Binds 127.0.0.1 only. Other devices reach it through Tailscale Serve HTTPS.
 * The session cookie is Secure (http://localhost is a Chromium secure context).
 * The GUI disk token never appears in the printed URL.
 *
 * Usage:
 *   node scripts/dev-web.mjs [--project /path/to/dir] [--no-open]
 *                            [--vite-url http://localhost:5173] [--api-port 5174]
 *                            [--port 5173]
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

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function bridgeFilePath() {
  const override = process.env.MAKA_WEB_BRIDGE_FILE?.trim();
  return override || join(tmpdir(), 'maka-web-bridge.json');
}

async function readBridgeFile() {
  try {
    const file = bridgeFilePath();
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed?.wsUrl || !parsed?.token) return null;
    return {
      wsUrl: parsed.wsUrl,
      token: parsed.token,
      file,
      webAccessPath: typeof parsed.webAccessPath === 'string' ? parsed.webAccessPath : '',
    };
  } catch {
    return null;
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
                           [--port 5173]

Binds 127.0.0.1 only (no 0.0.0.0). Open http://localhost:5173/login.
Other devices: Tailscale Serve HTTPS:

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
const requestedHost = argValue(argv, 'host', '127.0.0.1');
const vitePort = Number(argValue(argv, 'port', '5173')) || 5173;
if (requestedHost && !isLoopbackHost(requestedHost)) {
  console.error(
    `[web] refusing --host ${requestedHost}; Maka binds 127.0.0.1 only. Put Tailscale Serve in front:\n  tailscale serve --bg http://127.0.0.1:${vitePort}`,
  );
  process.exit(1);
}
const viteHost = '127.0.0.1';

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

// Live options: attach immediately so / and /bridge are gated before any
// request is served. Fill token/path when the GUI writes the token file.
const gatewayOptions = {
  webAccessPath: '',
  bridgeToken: '',
  bridgePort: 53217,
  secureCookies: true,
};
let lastBridgeToken = '';

function applyBridge(bridge) {
  if (!bridge) return;
  gatewayOptions.webAccessPath = bridge.webAccessPath || gatewayOptions.webAccessPath;
  gatewayOptions.bridgeToken = bridge.token;
  try {
    const wsUrl = new URL(bridge.wsUrl);
    gatewayOptions.bridgePort = Number(wsUrl.port) || 53217;
  } catch {
    gatewayOptions.bridgePort = 53217;
  }
  if (bridge.token !== lastBridgeToken) {
    lastBridgeToken = bridge.token;
    log('web', `full client: /bridge proxied with disk token from ${bridge.file}`);
  }
}

function failClosed(httpServer) {
  const existingRequest = httpServer.listeners('request').slice();
  httpServer.removeAllListeners('request');
  httpServer.on('request', (req, res) => {
    let path = '/';
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      path = '/';
    }
    if (
      path === '/login' ||
      path.startsWith('/@vite') ||
      path.startsWith('/@id') ||
      path.startsWith('/@fs') ||
      path.startsWith('/node_modules') ||
      path.startsWith('/.vite')
    ) {
      for (const listener of existingRequest) listener.call(httpServer, req, res);
      return;
    }
    res.writeHead(303, { Location: '/login' });
    res.end();
  });
  const existingUpgrade = httpServer.listeners('upgrade').slice();
  httpServer.removeAllListeners('upgrade');
  httpServer.on('upgrade', (req, socket, head) => {
    let path = '/';
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      path = '/';
    }
    if (path === '/bridge') {
      try {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } catch {
        // Socket already gone.
      }
      socket.destroy();
      return;
    }
    for (const listener of existingUpgrade) listener.call(httpServer, req, socket, head);
  });
}

let gatewayAttached = false;
async function attachGateway(httpServer) {
  if (gatewayAttached) return;
  try {
    const { attachWebGateway } = await import('../dist/main/web-gateway/attach.js');
    attachWebGateway(httpServer, gatewayOptions);
    gatewayAttached = true;
    log('web', 'gateway attached (Secure session cookie; bridge token stays on disk)');
  } catch (error) {
    const detail = error?.message ?? error;
    log('web', `gateway module missing (${detail}); start maka-gui once so dist/main exists`);
    failClosed(httpServer);
    gatewayAttached = true;
  }
}

function pollBridgeFile() {
  const tick = async () => {
    applyBridge(await readBridgeFile());
    setTimeout(tick, 1000);
  };
  void tick();
}

// 2. Renderer: this process must own Vite so attachWebGateway can intercept
// /login and /bridge before the first request. `--vite-url` points at an
// already-running server (no gateway in that case).
let devUrl = explicitViteUrl;
if (devUrl && !(await probe(devUrl))) {
  console.error(`[web] --vite-url ${devUrl} is not reachable; aborting.`);
  await api.close();
  process.exit(1);
}
async function startOwnVite() {
  process.chdir(DESKTOP_DIR);
  log('web', `starting vite dev server on ${viteHost}:${vitePort} (loopback only)...`);
  applyBridge(await readBridgeFile());
  const server = await createServer({
    server: {
      host: viteHost,
      port: vitePort,
      allowedHosts: ['.ts.net', 'localhost'],
    },
    plugins: [
      {
        name: 'maka-web-gateway',
        async configureServer(vite) {
          if (vite.httpServer) await attachGateway(vite.httpServer);
        },
      },
    ],
  });
  await server.listen();
  if (server.httpServer && !gatewayAttached) await attachGateway(server.httpServer);
  server.printUrls();
  return server;
}

let viteServer;
if (!devUrl) {
  viteServer = await startOwnVite();
  devUrl = viteServer.resolvedUrls?.local?.[0]?.replace(/\/$/, '') ?? `http://localhost:${vitePort}`;
  log('web', 'warming renderer entry...');
  try {
    await viteServer.environments.client.warmupRequest('/main.tsx');
    await viteServer.environments.client.waitForRequestsIdle();
  } catch {
    // Warmup is best-effort; the page still loads without it.
  }
} else {
  log('web', 'explicit --vite-url; gateway not attached in this process');
}

pollBridgeFile();
const boundPort = Number(new URL(devUrl).port || vitePort) || vitePort;
const loginUrl = `http://localhost:${boundPort}/login`;
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
