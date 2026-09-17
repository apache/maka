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

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import {
  COMMANDCODE_LOGIN_ALLOWED_ORIGINS,
  COMMANDCODE_LOGIN_BODY_LIMIT_BYTES,
  CommandCodeBrowserLoginController,
  buildCommandCodeAuthUrl,
  studioBaseForApiBase,
} from '../commandcode-browser-login.js';

// Every test binds a real loopback listener and talks to it with real fetch —
// exactly the requests the Studio page makes. Only the browser is replaced.

const STATE = 'test-state-token';
const controllers: CommandCodeBrowserLoginController[] = [];
const netServers: NetServer[] = [];

function makeController(
  overrides: Partial<ConstructorParameters<typeof CommandCodeBrowserLoginController>[0]> = {},
  opened: string[] = [],
) {
  const controller = new CommandCodeBrowserLoginController({
    openExternal: async (url) => {
      opened.push(url);
    },
    // Off the CLI's range so a developer's own `command-code login` and the
    // tests never contend for a port.
    startPort: 46_959,
    maxPortAttempts: 10,
    randomToken: () => STATE,
    ...overrides,
  });
  controllers.push(controller);
  return controller;
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.dispose();
  await Promise.all(
    netServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function startOk(controller: CommandCodeBrowserLoginController, baseUrl?: string) {
  const started = await controller.start(baseUrl === undefined ? {} : { baseUrl });
  assert.equal(started.ok, true, `start failed: ${JSON.stringify(started)}`);
  if (!started.ok) throw new Error('unreachable');
  const url = new URL(started.authUrl);
  const callback = new URL(url.searchParams.get('callback') ?? '');
  return { ...started, callback: callback.toString(), port: Number(callback.port) };
}

function post(url: string, body: unknown, init: RequestInit = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...(init.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

const APPROVED = {
  apiKey: 'user_secret_key',
  state: STATE,
  userId: 'u1',
  userName: 'joobin',
  keyName: 'maka-desktop',
};

/** True when the port could be taken, i.e. no attempt is listening on it. */
async function isPortFree(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await occupyPort(port);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return false;
}

function occupyPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      netServers.push(server);
      resolve();
    });
  });
}

describe('studio URL derivation', () => {
  test('maps the Provider API base to the Studio that mints its keys', () => {
    assert.equal(studioBaseForApiBase(undefined), 'https://commandcode.ai');
    assert.equal(
      studioBaseForApiBase('https://api.commandcode.ai/provider/v1'),
      'https://commandcode.ai',
    );
    assert.equal(
      studioBaseForApiBase('https://staging-api.commandcode.ai/provider/v1'),
      'https://staging.commandcode.ai',
    );
    assert.equal(studioBaseForApiBase('http://localhost:8080/provider/v1'), 'http://localhost:3000');
    // A lookalike host must not be trusted as staging.
    assert.equal(
      studioBaseForApiBase('https://staging-api.commandcode.ai.evil.example/'),
      'https://commandcode.ai',
    );
  });

  test('builds the CLI approval URL with an encoded loopback callback', () => {
    const url = new URL(
      buildCommandCodeAuthUrl({ studioBase: 'https://commandcode.ai', port: 5959, state: 'a b' }),
    );
    assert.equal(url.origin + url.pathname, 'https://commandcode.ai/studio/auth/cli');
    assert.equal(url.searchParams.get('callback'), 'http://localhost:5959/callback');
    assert.equal(url.searchParams.get('state'), 'a b');
  });
});

describe('CommandCodeBrowserLoginController', () => {
  test('start binds the first free port in range and opens the approval page there', async () => {
    const opened: string[] = [];
    const controller = makeController({}, opened);
    const started = await startOk(controller);
    assert.equal(started.port, 46_959);
    assert.deepEqual(opened, [started.authUrl]);
    assert.equal(new URL(started.authUrl).searchParams.get('state'), STATE);
  });

  test('an approved callback settles complete() with the delivered credentials and closes the port', async () => {
    const controller = makeController();
    const started = await startOk(controller);
    const completion = controller.complete(started.attemptId);

    const response = await post(started.callback, APPROVED, {
      headers: { Origin: 'https://commandcode.ai' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://commandcode.ai');
    assert.deepEqual(await response.json(), { success: true });

    assert.deepEqual(await completion, {
      ok: true,
      credentials: { apiKey: 'user_secret_key', userName: 'joobin', keyName: 'maka-desktop' },
    });
    await assert.rejects(post(started.callback, APPROVED), 'the listener must be gone after settling');
  });

  test('credentials are delivered once: a second complete() for the same attempt is spent', async () => {
    const controller = makeController();
    const started = await startOk(controller);
    const first = controller.complete(started.attemptId);
    await post(started.callback, APPROVED);
    assert.equal((await first).ok, true);
    assert.deepEqual(await controller.complete(started.attemptId), {
      ok: false,
      reason: 'superseded',
    });
    assert.deepEqual(await controller.complete('never-issued'), { ok: false, reason: 'superseded' });
  });

  test('a state mismatch is answered 403 and the attempt keeps waiting', async () => {
    const controller = makeController();
    const started = await startOk(controller);
    const completion = controller.complete(started.attemptId);

    const stale = await post(started.callback, { ...APPROVED, state: 'stale' });
    assert.equal(stale.status, 403);
    // A forged denial without the state must not kill the live attempt.
    const forgedDenial = await post(started.callback, { error: 'access_denied', state: 'nope' });
    assert.equal(forgedDenial.status, 403);

    const approved = await post(started.callback, APPROVED);
    assert.equal(approved.status, 200);
    assert.equal((await completion).ok, true);
  });

  test('a denial carrying the real state ends the attempt as denied', async () => {
    const controller = makeController();
    const started = await startOk(controller);
    const completion = controller.complete(started.attemptId);
    const response = await post(started.callback, {
      error: 'access_denied',
      error_description: 'User declined',
      state: STATE,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await completion, { ok: false, reason: 'denied' });
  });

  test('the CORS preflight succeeds only for the Studio origins', async () => {
    const controller = makeController();
    const started = await startOk(controller);
    for (const origin of COMMANDCODE_LOGIN_ALLOWED_ORIGINS) {
      const preflight = await fetch(started.callback, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    }
    const foreign = await fetch(started.callback, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(foreign.status, 204);
    assert.equal(foreign.headers.get('access-control-allow-origin'), '');
  });

  test('malformed requests are refused without ending the attempt', async () => {
    const controller = makeController();
    const started = await startOk(controller);
    const completion = controller.complete(started.attemptId);
    const origin = `http://127.0.0.1:${started.port}`;

    assert.equal((await fetch(`${origin}/elsewhere`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(started.callback)).status, 405);
    assert.equal((await post(started.callback, '{not json')).status, 400);
    assert.equal((await post(started.callback, '[1,2]')).status, 400);
    // Right state, but no key: the shape gate runs after the state gate.
    assert.equal((await post(started.callback, { state: STATE, userName: 'x' })).status, 400);
    assert.equal(
      (await post(started.callback, { ...APPROVED, apiKey: '' })).status,
      400,
      'an empty key is not a credential',
    );

    let settled = false;
    void completion.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, 'none of the refused requests may settle the attempt');
    controller.cancel(started.attemptId);
    assert.deepEqual(await completion, { ok: false, reason: 'cancelled' });
  });

  test('a request whose Host is not the loopback authority is refused (DNS rebinding)', async () => {
    const controller = makeController();
    const started = await startOk(controller);
    // fetch forbids overriding Host, so this rides raw node:http.
    const rebound = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port: started.port,
          path: '/callback',
          method: 'POST',
          headers: { Host: `evil.example:${started.port}`, 'Content-Type': 'text/plain' },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.once('error', reject);
      request.end(JSON.stringify(APPROVED));
    });
    assert.equal(rebound, 403);
    const viaIp = await post(`http://127.0.0.1:${started.port}/callback`, APPROVED);
    assert.equal(viaIp.status, 200, 'both loopback spellings are the bound authority');
  });

  test('an over-limit body is dropped before it is parsed', async () => {
    const controller = makeController();
    const started = await startOk(controller);
    const completion = controller.complete(started.attemptId);
    // CJK padding: the cap is on wire bytes, so this crosses it well before
    // its string length would.
    const padding = '密'.repeat(COMMANDCODE_LOGIN_BODY_LIMIT_BYTES / 2);
    await assert.rejects(post(started.callback, { ...APPROVED, padding }));

    const approved = await post(started.callback, APPROVED);
    assert.equal(approved.status, 200);
    assert.equal((await completion).ok, true);
  });

  test('the login window elapsing settles the attempt as timeout', async () => {
    const controller = makeController({ timeoutMs: 30 });
    const started = await startOk(controller);
    assert.deepEqual(await controller.complete(started.attemptId), {
      ok: false,
      reason: 'timeout',
    });
    await assert.rejects(post(started.callback, APPROVED));
  });

  test('cancel settles the attempt and releases the port', async () => {
    const controller = makeController();
    const started = await startOk(controller);
    const completion = controller.complete(started.attemptId);
    controller.cancel();
    assert.deepEqual(await completion, { ok: false, reason: 'cancelled' });
    await assert.rejects(post(started.callback, APPROVED));
    // Cancelling again, or a stranger's id, is a no-op.
    controller.cancel(started.attemptId);
    controller.cancel('unknown');
  });

  test('a new start supersedes the live attempt and rebinds the same port', async () => {
    const controller = makeController();
    const first = await startOk(controller);
    const firstCompletion = controller.complete(first.attemptId);
    const second = await startOk(controller);
    assert.deepEqual(await firstCompletion, { ok: false, reason: 'superseded' });
    assert.equal(second.port, first.port, 'the superseded listener released its port');
    assert.notEqual(second.attemptId, first.attemptId);

    // The old state no longer opens anything.
    const completion = controller.complete(second.attemptId);
    assert.equal((await post(second.callback, APPROVED)).status, 200);
    assert.equal((await completion).ok, true);
  });

  test('two simultaneous starts leave one live attempt and free the loser\'s port', async () => {
    const opened: string[] = [];
    const controller = makeController({}, opened);
    // Both calls reach `start` before either has bound a port. Reserving the
    // attempt only after the bind let both survive, bind two ports, and each
    // deliver its own credentials.
    const [loser, winner] = await Promise.all([controller.start(), controller.start()]);
    assert.deepEqual(loser, { ok: false, reason: 'superseded' });
    assert.equal(winner.ok, true, JSON.stringify(winner));
    if (!winner.ok) throw new Error('unreachable');
    assert.deepEqual(opened, [winner.authUrl], 'only the live attempt opens a browser tab');

    const free: number[] = [];
    for (const port of [46_959, 46_960]) {
      if (await isPortFree(port)) free.push(port);
    }
    assert.equal(free.length, 1, `exactly one port stays bound, free: ${free.join(',')}`);

    const callback = new URL(new URL(winner.authUrl).searchParams.get('callback') ?? '');
    const completion = controller.complete(winner.attemptId);
    assert.equal((await post(callback.toString(), APPROVED)).status, 200);
    assert.equal((await completion).ok, true);
  });

  test('an occupied port is skipped for the next one in the CLI range', async () => {
    await occupyPort(46_959);
    const controller = makeController();
    const started = await startOk(controller);
    assert.equal(started.port, 46_960);
  });

  test('no free port in range fails the start without opening a browser', async () => {
    await occupyPort(46_959);
    const opened: string[] = [];
    const controller = makeController({ maxPortAttempts: 1 }, opened);
    assert.deepEqual(await controller.start(), { ok: false, reason: 'port_unavailable' });
    assert.deepEqual(opened, []);
  });

  test('a browser that cannot open fails the start and releases the port', async () => {
    const controller = makeController({
      openExternal: async () => {
        throw new Error('no default browser');
      },
    });
    assert.deepEqual(await controller.start(), { ok: false, reason: 'browser_unavailable' });
    // The port is free again for a controller that can open a browser.
    const next = makeController();
    const started = await startOk(next);
    assert.equal(started.port, 46_959);
  });

  test('a staging Provider API base sends the browser to the staging Studio', async () => {
    const controller = makeController();
    const started = await startOk(controller, 'https://staging-api.commandcode.ai/provider/v1');
    assert.equal(new URL(started.authUrl).origin, 'https://staging.commandcode.ai');
  });

  test('dispose cancels the live attempt and refuses later starts', async () => {
    const controller = makeController();
    const started = await startOk(controller);
    const completion = controller.complete(started.attemptId);
    controller.dispose();
    assert.deepEqual(await completion, { ok: false, reason: 'cancelled' });
    assert.equal((await controller.start()).ok, false);
  });
});
