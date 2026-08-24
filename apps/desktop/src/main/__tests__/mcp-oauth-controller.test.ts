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
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, test } from 'node:test';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_CONFIG_VERSION } from '@maka/core/mcp';
import { createMemoryMcpOAuthStorage, McpClientManager } from '@maka/mcp';
import { createMcpOAuthController } from '../mcp-oauth-controller.js';

// The whole desktop login path with a real manager, a real OAuth fixture and
// the real loopback callback listener. The only substitution is the browser:
// openExternal fetches the authorization URL and follows the 302 back to the
// 127.0.0.1 callback — exactly the two requests a real browser would make.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

test('controller login drives browser round-trip to a connected server', async () => {
  const fixture = await createOAuthFixture();
  const manager = new McpClientManager({ oauthStorage: createMemoryMcpOAuthStorage() });
  cleanups.push(() => manager.close());

  await manager.sync({
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url: fixture.mcpUrl, transport: 'streamable-http' } },
  });
  assert.equal(manager.status('remote')?.state, 'needs-auth');

  const browserVisits: string[] = [];
  const controller = createMcpOAuthController({
    manager,
    openExternal: async (url) => {
      browserVisits.push(url);
      // A browser: load the consent screen, then follow its redirect.
      const consent = await fetch(url, { redirect: 'manual' });
      assert.equal(consent.status, 302);
      const callback = await fetch(consent.headers.get('location') ?? '');
      assert.equal(callback.status, 200);
    },
  });

  const status = await controller.login('remote');
  assert.equal(status.state, 'connected');
  assert.equal(status.authenticated, true);
  assert.equal(browserVisits.length, 1);
  // The callback listener bound an ephemeral loopback port and the fixture
  // redirected straight into it.
  assert.match(new URL(browserVisits[0] ?? '').searchParams.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);

  const echoBinding = manager
    .toolSnapshot()
    .tools.find(
      (tool) => tool.descriptor.serverId === 'remote' && tool.descriptor.name === 'echo',
    )?.binding;
  assert.ok(echoBinding);
  const echo = await manager.callTool(echoBinding, { value: 'via-controller' });
  assert.deepEqual(echo.content, [{ type: 'text', text: 'via-controller' }]);

  const after = await controller.logout('remote');
  assert.equal(after.state, 'needs-auth');
});

test('resumeLogin rebinds the persisted callback port and completes the round', async () => {
  const fixture = await createOAuthFixture();
  const storage = createMemoryMcpOAuthStorage();
  const manager = new McpClientManager({ oauthStorage: storage });
  cleanups.push(() => manager.close());
  await manager.sync({
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url: fixture.mcpUrl, transport: 'streamable-http' } },
  });
  assert.equal(manager.status('remote')?.state, 'needs-auth');

  // "First run": a login starts — verifier, state and the callback port are
  // persisted — and the app dies before the browser returns.
  const port = await freeLoopbackPort();
  const start = await manager.startAuthorization('remote', `http://127.0.0.1:${port}/callback`, {
    state: 'resume-state',
  });
  assert.equal(start.status, 'redirect');
  if (start.status !== 'redirect') return;

  // "Second run": the controller rebinds the persisted port from storage.
  const controller = createMcpOAuthController({ manager, openExternal: async () => {} });
  const resumed = controller.resumeLogin('remote');

  // The user's browser finishes the round it had already started.
  const consent = await fetch(start.authorizationUrl, { redirect: 'manual' });
  assert.equal(consent.status, 302);
  const location = consent.headers.get('location');
  assert.ok(location);
  const callback = await fetchWithRetry(location);
  assert.equal(callback.status, 200);

  const status = await resumed;
  assert.equal(status?.state, 'connected');
  assert.equal(status?.authenticated, true);

  // Nothing left to resume once the round settled.
  assert.equal(await controller.resumeLogin('remote'), undefined);
});

test('resumeLogin resolves undefined when the persisted port is already taken', async () => {
  const fixture = await createOAuthFixture();
  const storage = createMemoryMcpOAuthStorage();
  const manager = new McpClientManager({ oauthStorage: storage });
  cleanups.push(() => manager.close());
  await manager.sync({
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url: fixture.mcpUrl, transport: 'streamable-http' } },
  });

  const port = await freeLoopbackPort();
  const start = await manager.startAuthorization('remote', `http://127.0.0.1:${port}/callback`, {
    state: 'occupied-port-state',
  });
  assert.equal(start.status, 'redirect');

  // Something else grabbed the port before the restart's resume ran.
  const squatter = createServer();
  await new Promise<void>((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen(port, '127.0.0.1', resolve);
  });
  try {
    const controller = createMcpOAuthController({ manager, openExternal: async () => {} });
    // Per contract this is "nothing to resume", not a failure.
    assert.equal(await controller.resumeLogin('remote'), undefined);
  } finally {
    squatter.closeAllConnections();
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  }
});

test('login refuses a cleartext non-loopback authorization URL without opening it', async () => {
  const opened: string[] = [];
  const controller = createMcpOAuthController({
    manager: {
      startAuthorization: async () => ({
        status: 'redirect',
        state: 's',
        issuer: 'https://as.example',
        scopes: ['files:read'],
        authorizationUrl: 'http://as.example.com/authorize',
      }),
      finishAuthorization: async () => {
        throw new Error('unreachable');
      },
      clearAuthorization: async () => {
        throw new Error('unreachable');
      },
      abandonAuthorization: async () => {},
      pendingAuthorization: async () => undefined,
      status: () => undefined,
    },
    openExternal: async (url) => {
      opened.push(url);
    },
  });
  await assert.rejects(controller.login('remote'), /https/u);
  assert.deepEqual(opened, []);
});

test('a reflected error_description never crosses into the login rejection', async () => {
  const fixture = await createOAuthFixture({
    authorizeError: 'access_denied',
    authorizeErrorDescription: 'leak token-echo-abcdef',
  });
  const manager = new McpClientManager({ oauthStorage: createMemoryMcpOAuthStorage() });
  cleanups.push(() => manager.close());
  await manager.sync({
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url: fixture.mcpUrl, transport: 'streamable-http' } },
  });

  const controller = createMcpOAuthController({
    manager,
    openExternal: async (url) => {
      const consent = await fetch(url, { redirect: 'manual' });
      const location = consent.headers.get('location');
      assert.ok(location);
      await fetch(location);
    },
  });

  await assert.rejects(controller.login('remote'), (error: unknown) => {
    assert.ok(error instanceof Error);
    // The description is the server's arbitrary string; only the registered
    // error code may cross toward the renderer.
    assert.doesNotMatch(error.message, /token-echo-abcdef/u);
    assert.match(error.message, /access_denied/u);
    return true;
  });
});

test('an unregistered callback error code is generalized before crossing IPC', async () => {
  const fixture = await createOAuthFixture({ authorizeError: 'opaqueSecret123' });
  const manager = new McpClientManager({ oauthStorage: createMemoryMcpOAuthStorage() });
  cleanups.push(() => manager.close());
  await manager.sync({
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url: fixture.mcpUrl, transport: 'streamable-http' } },
  });

  const controller = createMcpOAuthController({
    manager,
    openExternal: async (url) => {
      const consent = await fetch(url, { redirect: 'manual' });
      const location = consent.headers.get('location');
      assert.ok(location);
      await fetch(location);
    },
  });

  await assert.rejects(controller.login('remote'), (error: unknown) => {
    assert.ok(error instanceof Error);
    // Only allowlisted RFC 6749 codes may cross; an attacker-shaped code
    // that merely looks like an identifier must not tunnel through.
    assert.doesNotMatch(error.message, /opaqueSecret123/u);
    assert.match(error.message, /unknown_error/u);
    return true;
  });
});

test('controller rejects a forged callback state and an OAuth error response', async () => {
  const fixture = await createOAuthFixture({ authorizeError: 'access_denied' });
  const manager = new McpClientManager({ oauthStorage: createMemoryMcpOAuthStorage() });
  cleanups.push(() => manager.close());
  await manager.sync({
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url: fixture.mcpUrl, transport: 'streamable-http' } },
  });

  const controller = createMcpOAuthController({
    manager,
    openExternal: async (url) => {
      const authorization = new URL(url);
      const redirectUri = new URL(authorization.searchParams.get('redirect_uri') ?? '');
      // A forged state must be rejected without settling the login...
      redirectUri.searchParams.set('code', 'forged');
      redirectUri.searchParams.set('state', 'wrong');
      const forged = await fetch(redirectUri);
      assert.equal(forged.status, 400);
      // ...and then the real consent screen reports the user's refusal.
      const consent = await fetch(url, { redirect: 'manual' });
      const location = consent.headers.get('location');
      assert.ok(location);
      await fetch(location);
    },
  });

  await assert.rejects(controller.login('remote'), /access_denied|Authorization failed/u);
  assert.equal(manager.status('remote')?.state, 'needs-auth');
  // The denied round is terminally dead: its persisted verifier/state are
  // abandoned, so nothing resumes it after a restart (and the login guard
  // is not re-occupied on every boot).
  assert.equal(await manager.pendingAuthorization('remote'), undefined);
  assert.equal(await controller.resumeLogin('remote'), undefined);
});

test('a hung readiness gate or store lookup cannot outlive the round deadline', async () => {
  // Preflight is controller-owned and deadline-raced: a wedged ensureReady
  // or credential/config store read must not park the promise (and the
  // renderer's per-server login lock) forever.
  for (const wedge of ['ready', 'store'] as const) {
    const controller = createMcpOAuthController({
      manager: {
        startAuthorization: async () => {
          throw new Error('preflight must fail first');
        },
        finishAuthorization: async () => {
          throw new Error('not used');
        },
        clearAuthorization: async () => {
          throw new Error('not used');
        },
        abandonAuthorization: async () => {},
        pendingAuthorization: async () => undefined,
        status: () => undefined,
      },
      openExternal: async () => {
        throw new Error('the browser must not open');
      },
      ensureReady: wedge === 'ready' ? () => new Promise(() => {}) : undefined,
      callbackPort: wedge === 'store' ? () => new Promise(() => {}) : undefined,
      loginTimeoutMs: 60,
    });
    await assert.rejects(controller.login('remote'), /Timed out/u);
    // Guard released: the retry runs instead of "already in progress".
    await assert.rejects(controller.login('remote'), /Timed out/u);
  }
});

test('cancelling a round releases the guard and clears the pending state', async () => {
  // "Clicked Login, closed the tab" must not be a five-minute trap in
  // which every config edit for the server is vetoed: cancel ends the
  // round like a timeout — rejection, guard release, terminal cleanup.
  const abandoned: string[] = [];
  const controller = createMcpOAuthController({
    manager: {
      startAuthorization: async () => ({
        status: 'redirect' as const,
        authorizationUrl: 'https://as.example/authorize',
        state: 's',
        issuer: 'https://as.example',
        scopes: ['files:read'],
      }),
      finishAuthorization: async () => {
        throw new Error('not used');
      },
      clearAuthorization: async () => {
        throw new Error('not used');
      },
      abandonAuthorization: async (serverId) => {
        abandoned.push(serverId);
      },
      pendingAuthorization: async () => undefined,
      status: () => undefined,
    },
    // The browser opens and the callback never arrives.
    openExternal: async () => {},
    loginTimeoutMs: 60_000,
  });

  const login = controller.login('remote');
  login.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.isActive('remote'), true);

  assert.equal(controller.cancelLogin('remote'), true);
  await assert.rejects(login, /cancelled/u);
  assert.equal(controller.isActive('remote'), false);
  assert.deepEqual(abandoned, ['remote']);
  // No round → nothing to cancel.
  assert.equal(controller.cancelLogin('remote'), false);
});

test('a hung terminal-failure cleanup cannot park the login rejection', async () => {
  // The abandon often shares the exact resource that stalled the round (a
  // wedged credential lane): awaiting it unbounded would hold the rejection
  // — and the renderer's login lock — forever.
  const controller = createMcpOAuthController({
    manager: {
      startAuthorization: async () => {
        throw new Error('authorization endpoint refused');
      },
      finishAuthorization: async () => {
        throw new Error('not used');
      },
      clearAuthorization: async () => {
        throw new Error('not used');
      },
      // The cleanup itself never settles.
      abandonAuthorization: () => new Promise(() => {}),
      pendingAuthorization: async () => undefined,
      status: () => undefined,
    },
    openExternal: async () => {
      throw new Error('the browser must not open');
    },
    loginTimeoutMs: 60,
  });
  await assert.rejects(controller.login('remote'), /authorization endpoint refused/u);
  // The guard released with the bounded cleanup: a retry runs.
  await assert.rejects(controller.login('remote'), /authorization endpoint refused/u);
});

test('a timed-out logout aborts the in-flight credential clear', async () => {
  // Racing alone would abandon the caller while the stalled clear kept
  // running — free to resume later and tombstone the fresh tokens a newer
  // login stored. The deadline's signal must travel INTO the clear.
  const seen: Array<AbortSignal | undefined> = [];
  const controller = createMcpOAuthController({
    manager: {
      startAuthorization: async () => {
        throw new Error('not used');
      },
      finishAuthorization: async () => {
        throw new Error('not used');
      },
      clearAuthorization: (_serverId, options) => {
        seen.push(options?.signal);
        return new Promise(() => {});
      },
      abandonAuthorization: async () => {},
      pendingAuthorization: async () => undefined,
      status: () => undefined,
    },
    openExternal: async () => {
      throw new Error('the browser must not open');
    },
    loginTimeoutMs: 60,
  });
  await assert.rejects(controller.logout('remote'), /Timed out/u);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]);
  assert.equal(seen[0]?.aborted, true);
});

test('a hung readiness gate or credential clear cannot outlive the logout deadline', async () => {
  // Logout is bounded like login: a wedged ensureReady or a hung
  // clearAuthorization (store erase / reconnect) must not park the
  // renderer's logout lock forever.
  for (const wedge of ['ready', 'clear'] as const) {
    const controller = createMcpOAuthController({
      manager: {
        startAuthorization: async () => {
          throw new Error('not used');
        },
        finishAuthorization: async () => {
          throw new Error('not used');
        },
        clearAuthorization:
          wedge === 'clear'
            ? () => new Promise(() => {})
            : async () => {
                throw new Error('readiness must fail first');
              },
        abandonAuthorization: async () => {},
        pendingAuthorization: async () => undefined,
        status: () => undefined,
      },
      openExternal: async () => {
        throw new Error('the browser must not open');
      },
      ensureReady: wedge === 'ready' ? () => new Promise(() => {}) : undefined,
      loginTimeoutMs: 60,
    });
    await assert.rejects(controller.logout('remote'), /Timed out/u);
  }
});

test('a hung browser launch cannot outlive the round deadline', async () => {
  const controller = createMcpOAuthController({
    manager: {
      startAuthorization: async () => ({
        status: 'redirect' as const,
        state: 's',
        issuer: 'https://as.example',
        scopes: ['files:read'],
        authorizationUrl: 'https://as.example/authorize',
      }),
      finishAuthorization: async () => {
        throw new Error('not used');
      },
      clearAuthorization: async () => {
        throw new Error('not used');
      },
      abandonAuthorization: async () => {},
      pendingAuthorization: async () => undefined,
      status: () => undefined,
    },
    // The shell accepts the launch request and never settles.
    openExternal: () => new Promise(() => {}),
    loginTimeoutMs: 100,
  });
  await assert.rejects(controller.login('remote'), /Timed out/u);
  // The guard released with the round; a retry is not "already in progress".
  await assert.rejects(controller.login('remote'), /Timed out/u);
});

test('a hung discovery cannot hold the login guard past the deadline', async () => {
  // The deadline covers the whole round: a metadata endpoint that accepts
  // the connection and never answers must not park the login forever.
  let starts = 0;
  const roundSignals: Array<AbortSignal | undefined> = [];
  const controller = createMcpOAuthController({
    manager: {
      startAuthorization: (_serverId, _redirectUrl, options) => {
        starts += 1;
        roundSignals.push(options?.signal);
        return new Promise(() => {});
      },
      finishAuthorization: async () => {
        throw new Error('not used');
      },
      clearAuthorization: async () => {
        throw new Error('not used');
      },
      abandonAuthorization: async () => {},
      pendingAuthorization: async () => undefined,
      status: () => undefined,
    },
    openExternal: async () => {
      throw new Error('the browser must not open for a hung discovery');
    },
    loginTimeoutMs: 50,
  });
  await assert.rejects(controller.login('remote'), /Timed out/u);
  // The in-progress guard released with the round — a retry starts cleanly
  // instead of being refused as already in progress.
  await assert.rejects(controller.login('remote'), /Timed out/u);
  assert.equal(starts, 2);
  // The timeout did not merely abandon the caller: each round's underlying
  // flow received the deadline's signal and was aborted with it, so a late
  // completion cannot write over a newer round (the manager fences every
  // storage write on this signal).
  assert.equal(roundSignals.length, 2);
  for (const signal of roundSignals) {
    assert.ok(signal);
    assert.equal(signal.aborted, true);
  }
});

test('a hung token endpoint releases the listener and the guard at the deadline', async () => {
  let capturedRedirect = '';
  let capturedState = '';
  let finishSignal: AbortSignal | undefined;
  const controller = createMcpOAuthController({
    manager: {
      startAuthorization: async (_serverId, redirectUrl, options) => {
        capturedRedirect = redirectUrl;
        capturedState = options?.state ?? '';
        return {
          status: 'redirect' as const,
          authorizationUrl: 'https://as.example/authorize',
          state: 's',
          issuer: 'https://as.example',
          scopes: ['files:read'],
        };
      },
      // The token exchange hangs: connection accepted, response never sent.
      finishAuthorization: (_serverId, _callback, options) => {
        finishSignal = options?.signal;
        return new Promise(() => {});
      },
      clearAuthorization: async () => {
        throw new Error('not used');
      },
      abandonAuthorization: async () => {},
      pendingAuthorization: async () => undefined,
      status: () => undefined,
    },
    openExternal: async () => {
      // The browser round itself completes fine…
      const callback = new URL(capturedRedirect);
      callback.searchParams.set('state', capturedState);
      callback.searchParams.set('code', 'hung-code');
      const response = await fetch(callback);
      assert.equal(response.status, 200);
    },
    // Generous enough that the real loopback fetch in openExternal cannot
    // eat the budget on a stalled runner; the hung exchange still dominates.
    loginTimeoutMs: 750,
  });
  // …and the round still times out on the exchange.
  await assert.rejects(controller.login('remote'), /Timed out/u);
  // The loopback listener closed with the round; the port is released.
  await assert.rejects(fetch(capturedRedirect));
  // The hung exchange was aborted with the round, so its late completion
  // cannot land writes over a newer round.
  assert.equal(finishSignal?.aborted, true);
});

interface OAuthFixture {
  mcpUrl: string;
}

/** An OS-assigned port that is free right now — bound briefly, then
 * released for the resume flow to claim. */
async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('probe did not bind');
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** The resumed listener binds asynchronously; retry briefly so the
 * browser's callback does not race it. */
async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

async function createOAuthFixture(
  options: { authorizeError?: string; authorizeErrorDescription?: string } = {},
): Promise<OAuthFixture> {
  const accessToken = `token-${randomUUID()}`;
  const pendingCodes = new Map<string, { challenge: string }>();
  let origin = '';

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    try {
      if (url.pathname === '/mcp' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${accessToken}`) {
          res
            .writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
            })
            .end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = createProtocolServer();
        await server.connect(transport);
        res.once('close', () => {
          void transport.close();
          void server.close();
        });
        await transport.handleRequest(req, res, await readJsonBody(req));
        return;
      }
      if (url.pathname === '/.well-known/oauth-protected-resource') {
        json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        json(res, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        json(res, {
          client_id: `client-${randomUUID()}`,
          redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: 'none',
        });
        return;
      }
      if (url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        const challenge = url.searchParams.get('code_challenge');
        if (!redirectUri || !challenge) {
          res.writeHead(400).end('missing parameters');
          return;
        }
        const target = new URL(redirectUri);
        if (options.authorizeError) {
          target.searchParams.set('error', options.authorizeError);
          if (options.authorizeErrorDescription) {
            target.searchParams.set('error_description', options.authorizeErrorDescription);
          }
        } else {
          const code = `code-${randomUUID()}`;
          pendingCodes.set(code, { challenge });
          target.searchParams.set('code', code);
        }
        if (state) target.searchParams.set('state', state);
        res.writeHead(302, { location: target.toString() }).end();
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(await readTextBody(req));
        const pending = pendingCodes.get(params.get('code') ?? '');
        const hashed = createHash('sha256')
          .update(params.get('code_verifier') ?? '')
          .digest('base64url');
        if (!pending || hashed !== pending.challenge) {
          json(res, { error: 'invalid_grant' }, 400);
          return;
        }
        json(res, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 });
        return;
      }
      res.writeHead(404).end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('OAuth fixture did not bind TCP');
  origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { mcpUrl: `${origin}/mcp` };
}

function createProtocolServer(): McpServer {
  const server = new McpServer(
    { name: 'maka-oauth-controller-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo text',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
    content: [{ type: 'text', text: String(params.arguments?.value ?? '') }],
  }));
  return server;
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readTextBody(req);
  return text ? JSON.parse(text) : undefined;
}

function readTextBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += String(chunk);
    });
    req.once('end', () => resolve(data));
    req.once('error', reject);
  });
}
