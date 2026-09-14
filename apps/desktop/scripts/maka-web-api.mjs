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
 * Minimal local API for `maka-web` (Chrome/Brave mode).
 *
 * The Electron GUI talks to the main process over IPC; a plain browser has
 * no preload, so the renderer needs an HTTP fallback for at least the
 * directory flow the user asked for: type/paste a server-local path, have
 * the local machine validate it, and open it. Full session/runtime APIs
 * stay Electron-only in this iteration — this server deliberately covers
 * only path validation + health so the web picker can work while both
 * `maka-gui` (Electron) and `maka-web` (browser) run side by side.
 *
 * Endpoints (JSON, CORS open for the vite dev origin):
 *   GET  /api/health            -> { ok, service, version }
 *   POST /api/paths/resolve     { path } -> { ok:true, path } | { ok:false, reason }
 *
 * No dependencies; plain node:http so `npm run web` needs no install.
 */
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { realpath, stat } from 'node:fs/promises';

export const DEFAULT_WEB_API_PORT = 5174;

function expandUser(input) {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return homedir() + input.slice(1);
  return input;
}

async function resolveLocalPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, reason: 'invalid-path' };
  }
  const expanded = expandUser(raw.trim());
  try {
    const info = await stat(expanded);
    if (!info.isDirectory()) return { ok: false, reason: 'not-a-directory' };
  } catch {
    return { ok: false, reason: 'not-found' };
  }
  try {
    return { ok: true, path: await realpath(expanded) };
  } catch {
    return { ok: true, path: expanded };
  }
}

function readJsonBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let seen = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      seen += chunk.length;
      if (seen > limitBytes) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

export function createWebApiServer({ port = DEFAULT_WEB_API_PORT } = {}) {
  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'maka-web', version: 1 }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/paths/resolve') {
        const body = await readJsonBody(req);
        const result = await resolveLocalPath(body?.path);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'not-found' }));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: 'bad-request' }));
    }
  });
  return {
    server,
    listen() {
      return new Promise((resolveListen, rejectListen) => {
        const onError = (error) => {
          server.off('listening', onListening);
          rejectListen(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolveListen(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
    },
    close() {
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
