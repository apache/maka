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
import { createServer, type IncomingMessage } from 'node:http';
import { afterEach, describe, test } from 'node:test';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MCP_CONFIG_VERSION, type McpConfigFile } from '@maka/core/mcp';
import {
  createMemoryMcpOAuthStorage,
  McpClientManager,
  McpOAuthProvider,
  type McpOAuthRecord,
  type McpOAuthStorage,
} from '../index.js';

// End-to-end OAuth against a real authorization server fixture: RFC 9728
// protected-resource discovery from the 401, dynamic client registration,
// PKCE authorization-code exchange, and the authorized reconnect. The
// "browser" is a manual fetch of the authorization URL; the fixture
// auto-approves and redirects with a code, exactly like a consent screen.

const managers: McpClientManager[] = [];
const fixtures: OAuthFixture[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('McpClientManager OAuth E2E', () => {
  test('needs-auth → authorize → connected, with PKCE and Bearer-protected calls', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);

    await manager.sync(config(fixture.mcpUrl));
    assert.equal(manager.status('remote')?.state, 'needs-auth');
    assert.equal(manager.status('remote')?.error, undefined);
    // The background 401 round persisted its discovery (including the
    // WWW-Authenticate resource_metadata URL), so the interactive login
    // below starts from that context instead of a from-scratch discovery.
    assert.ok((await storage.get('remote'))?.discovery?.authorizationServerUrl);

    const redirectUrl = 'http://127.0.0.1:39999/callback';
    const start = await manager.startAuthorization('remote', redirectUrl, { state: 'maka-state' });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    const authorizationUrl = new URL(start.authorizationUrl);
    assert.equal(authorizationUrl.pathname, '/authorize');
    assert.equal(authorizationUrl.searchParams.get('state'), 'maka-state');
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), redirectUrl);
    // The 401 challenge's scope made it into the authorization request.
    assert.equal(authorizationUrl.searchParams.get('scope'), 'files:read');
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorizationUrl.searchParams.get('code_challenge'));
    // Dynamic registration ran before the redirect.
    assert.ok(fixture.registrations.length >= 1);
    // Consent disclosure material: the resolved issuer, the scope the round
    // requests, and the round's state travel back to the caller so a UI can
    // show what is being granted before a browser opens.
    assert.ok(start.issuer);
    assert.equal(new URL(start.issuer).origin, authorizationUrl.origin);
    assert.deepEqual(start.scopes, ['files:read']);
    assert.equal(start.state, 'maka-state');
    // An interactive round parks background connects: they would persist
    // discovery state through the same record and trip the round's version
    // fence. connect() defers instead of opening.
    const versionMidRound = (await storage.get('remote'))?.version;
    await manager.connect('remote');
    assert.equal((await storage.get('remote'))?.version, versionMidRound);
    assert.notEqual(manager.status('remote')?.state, 'connected');

    // The user's browser: hit the consent screen, get redirected back.
    const consent = await fetch(authorizationUrl, { redirect: 'manual' });
    assert.equal(consent.status, 302);
    const location = new URL(consent.headers.get('location') ?? '');
    assert.equal(`${location.protocol}//${location.host}${location.pathname}`, redirectUrl);
    assert.equal(location.searchParams.get('state'), 'maka-state');
    const code = location.searchParams.get('code');
    assert.ok(code);

    const status = await manager.finishAuthorization('remote', { code, state: 'maka-state' });
    assert.equal(status.state, 'connected');
    assert.equal(status.authenticated, true);
    assert.deepEqual(
      await manager.callTool(bindingFor(manager, 'remote', 'echo'), { value: 'authorized' }),
      {
        content: [{ type: 'text', text: 'authorized' }],
        structuredContent: undefined,
      },
    );
    assert.ok(
      fixture.mcpRequests.some(
        (request) => request.authorization === `Bearer ${fixture.accessToken}`,
      ),
    );
    // The PKCE verifier round-tripped: the token endpoint checked S256(verifier).
    assert.equal(fixture.tokenExchanges.length, 1);
    assert.equal(fixture.tokenExchanges[0]?.pkceVerified, true);

    const cleared = await manager.clearAuthorization('remote');
    assert.equal(cleared.state, 'needs-auth');
  });

  test('reconnects silently once tokens are stored', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);

    await manager.sync(config(fixture.mcpUrl));
    const status = manager.status('remote');
    assert.equal(status?.state, 'connected');
    assert.equal(status?.authenticated, true);
  });

  test('a background connect refreshes a stale token silently, without a browser round', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      clientInformation: { client_id: 'stored-client' },
      tokens: {
        access_token: 'stale-token',
        token_type: 'Bearer',
        refresh_token: fixture.refreshToken,
      },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);

    await manager.sync(config(fixture.mcpUrl));
    const status = manager.status('remote');
    assert.equal(status?.state, 'connected');
    assert.equal(status?.authenticated, true);
    assert.equal((await storage.get('remote'))?.tokens?.access_token, fixture.accessToken);
  });

  test('a revoked session surfaces needs-auth on the next tool call', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);

    await manager.sync(config(fixture.mcpUrl));
    assert.equal(manager.status('remote')?.state, 'connected');

    fixture.rotateAccessToken();
    await assert.rejects(
      manager.callTool(bindingFor(manager, 'remote', 'echo'), { value: 'revoked' }),
    );
    assert.equal(manager.status('remote')?.state, 'needs-auth');
  });

  test('a stored record issued for a different URL is dropped, never replayed', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    // An offline mcp.json edit repointed the same id: the manager never saw
    // the old config, so only the record's own binding can stop the replay.
    await storage.set('remote', {
      serverUrl: 'https://old.example/mcp',
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);

    await manager.sync(config(fixture.mcpUrl));
    assert.equal(manager.status('remote')?.state, 'needs-auth');
    assert.equal((await storage.get('remote'))?.tokens, undefined);
    assert.ok(
      !fixture.mcpRequests.some((req) => req.authorization === `Bearer ${fixture.accessToken}`),
    );
  });

  test('a token endpoint reflecting the client secret does not leak it through errors', async () => {
    const secret = 'super-secret-value-123';
    const fixture = await createOAuthFixture({ reflectInTokenError: secret });
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        remote: {
          url: fixture.mcpUrl,
          transport: 'streamable-http',
          oauth: { clientId: 'static-client', clientSecret: secret },
        },
      },
    });

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39998/callback', {
      state: 'scrub-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    const consent = await fetch(start.authorizationUrl, { redirect: 'manual' });
    const code = new URL(consent.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);

    await assert.rejects(
      manager.finishAuthorization('remote', { code, state: 'scrub-state' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /super-secret-value-123/u);
        assert.match(error.message, /\[redacted\]/u);
        return true;
      },
    );
  });

  test('a cross-origin redirect sheds the OAuth bearer token', async () => {
    const fixture = await createOAuthFixture();
    const collectorSeen: Array<string | undefined> = [];
    const collector = createServer((req, res) => {
      collectorSeen.push(
        typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      );
      res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((resolve, reject) => {
      collector.once('error', reject);
      collector.listen(0, '127.0.0.1', resolve);
    });
    const collectorAddress = collector.address();
    if (!collectorAddress || typeof collectorAddress === 'string')
      throw new Error('no collector port');
    const redirector = createServer((req, res) => {
      res
        .writeHead(307, {
          location: `http://127.0.0.1:${collectorAddress.port}${req.url ?? '/'}`,
        })
        .end();
    });
    await new Promise<void>((resolve, reject) => {
      redirector.once('error', reject);
      redirector.listen(0, '127.0.0.1', resolve);
    });
    const redirectorAddress = redirector.address();
    if (!redirectorAddress || typeof redirectorAddress === 'string')
      throw new Error('no redirector port');

    try {
      const storage = createMemoryMcpOAuthStorage();
      await storage.set('remote', {
        serverUrl: fixture.mcpUrl,
        tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
      });
      const manager = new McpClientManager({ oauthStorage: storage });
      managers.push(manager);
      await manager.sync({
        version: MCP_CONFIG_VERSION,
        mcpServers: {
          remote: {
            url: `http://127.0.0.1:${redirectorAddress.port}/mcp`,
            transport: 'streamable-http',
          },
        },
      });
      assert.notEqual(manager.status('remote')?.state, 'connected');
      assert.ok(collectorSeen.length > 0);
      for (const seen of collectorSeen) assert.equal(seen, undefined);
    } finally {
      collector.closeAllConnections();
      redirector.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => collector.close(() => resolve())),
        new Promise<void>((resolve) => redirector.close(() => resolve())),
      ]);
    }
  });

  test('reconnect failures reaching the caller are scrubbed of tokens and short secrets', async () => {
    const fixture = await createOAuthFixture({
      mcpFailureBody: (authorization) => `upstream rejected ${authorization ?? ''} secret=abcde`,
    });
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        remote: {
          url: fixture.mcpUrl,
          transport: 'streamable-http',
          oauth: { clientId: 'abc', clientSecret: 'abcde' },
        },
      },
    });
    const status = manager.status('remote');
    assert.equal(status?.state, 'error');
    assert.doesNotMatch(status?.error ?? '', new RegExp(fixture.accessToken, 'u'));
    assert.doesNotMatch(status?.error ?? '', /abcde/u);

    // The rejection is what mcp:reconnect forwards to the renderer.
    await assert.rejects(manager.reconnect('remote'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(fixture.accessToken, 'u'));
      assert.doesNotMatch(error.message, /abcde/u);
      assert.match(error.message, /\[redacted\]/u);
      return true;
    });
  });

  test('the challenge scope is found even when only the initialize POST answers 401', async () => {
    const fixture = await createOAuthFixture({ challengeOnPostOnly: true });
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));
    assert.equal(manager.status('remote')?.state, 'needs-auth');

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39997/callback', {
      state: 'post-only-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    assert.equal(new URL(start.authorizationUrl).searchParams.get('scope'), 'files:read');
  });

  test('reflected id_token material is scrubbed from outbound errors', async () => {
    const idToken = `idtok-${randomUUID()}`;
    const fixture = await createOAuthFixture({
      mcpFailureBody: (authorization) => `refused ${authorization ?? ''} ${idToken}`,
    });
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer', id_token: idToken },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));
    const status = manager.status('remote');
    assert.equal(status?.state, 'error');
    assert.doesNotMatch(status?.error ?? '', new RegExp(idToken, 'u'));
    assert.match(status?.error ?? '', /\[redacted\]/u);
  });

  test('a message containing a short secret is withheld wholesale', async () => {
    const fixture = await createOAuthFixture({
      mcpFailureBody: () => 'upstream rejected credential k7#',
    });
    const manager = new McpClientManager({ oauthStorage: createMemoryMcpOAuthStorage() });
    managers.push(manager);
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        remote: {
          url: fixture.mcpUrl,
          transport: 'streamable-http',
          // A 3-character secret cannot be spliced out without shredding the
          // message, so the whole message must be withheld instead.
          oauth: { clientId: 'abc-client', clientSecret: 'k7#' },
        },
      },
    });
    const status = manager.status('remote');
    assert.equal(status?.state, 'error');
    assert.doesNotMatch(status?.error ?? '', /k7#/u);
    assert.match(status?.error ?? '', /withheld/u);
  });

  test('a logout during a token refresh is terminal — the record is not resurrected', async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const fixture = await createOAuthFixture({
      holdRefresh: () => {
        markRefreshStarted();
        return refreshGate;
      },
    });
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      clientInformation: { client_id: 'stored-client' },
      tokens: {
        access_token: 'stale-token',
        token_type: 'Bearer',
        refresh_token: fixture.refreshToken,
      },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);

    const syncing = manager.sync(config(fixture.mcpUrl));
    await refreshStarted;
    // The user logs out while the refresh is in flight; when the fresh
    // tokens finally arrive, the late write must be refused.
    const clearing = manager.clearAuthorization('remote');
    releaseRefresh();
    await Promise.allSettled([syncing, clearing]);

    assert.equal((await storage.get('remote'))?.tokens, undefined);
    assert.equal(manager.status('remote')?.state, 'needs-auth');
  });

  test('the probe speaks the current protocol version to strict POST-only servers', async () => {
    const fixture = await createOAuthFixture({
      challengeOnPostOnly: true,
      requireProtocolVersion: LATEST_PROTOCOL_VERSION,
    });
    const manager = new McpClientManager({ oauthStorage: createMemoryMcpOAuthStorage() });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));
    assert.equal(manager.status('remote')?.state, 'needs-auth');

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39996/callback', {
      state: 'strict-version-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    assert.equal(new URL(start.authorizationUrl).searchParams.get('scope'), 'files:read');
  });

  test('a bare 401 on GET does not stop the probe from asking via POST', async () => {
    const fixture = await createOAuthFixture({ bareChallengeOnGet: true });
    const manager = new McpClientManager({ oauthStorage: createMemoryMcpOAuthStorage() });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));
    assert.equal(manager.status('remote')?.state, 'needs-auth');

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39995/callback', {
      state: 'bare-get-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    // The GET's parameterless challenge is not an answer; the POST's is.
    assert.equal(new URL(start.authorizationUrl).searchParams.get('scope'), 'files:read');
  });

  test('success payloads and tool metadata are scrubbed of reflected credentials', async () => {
    const fixture = await createOAuthFixture({ reflectAuthInProtocol: true });
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));
    const status = manager.status('remote');
    assert.equal(status?.state, 'connected');
    const tokenPattern = new RegExp(fixture.accessToken, 'u');
    // The server put the Bearer it received into the tool description…
    assert.doesNotMatch(status?.tools[0]?.description ?? '', tokenPattern);
    assert.match(status?.tools[0]?.description ?? '', /\[redacted\]/u);

    // …and into a successful result's content and structuredContent.
    const result = await manager.callTool(bindingFor(manager, 'remote', 'echo'), { value: 'ok' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    assert.doesNotMatch(text, tokenPattern);
    assert.match(text, /\[redacted\]/u);
    // Including object KEYS: { [token]: 'present' } must not leak either.
    assert.doesNotMatch(JSON.stringify(result.structuredContent), tokenPattern);
    assert.ok(
      Object.keys(result.structuredContent as Record<string, unknown>).some((key) =>
        key.includes('[redacted]'),
      ),
    );
  });

  test('a token endpoint reflecting the PKCE verifier does not leak it', async () => {
    const fixture = await createOAuthFixture({ reflectVerifierInTokenError: true });
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39994/callback', {
      state: 'verifier-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    const consent = await fetch(start.authorizationUrl, { redirect: 'manual' });
    const code = new URL(consent.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);
    const verifier = (await storage.get('remote'))?.codeVerifier;
    assert.ok(verifier);

    await assert.rejects(
      manager.finishAuthorization('remote', { code, state: 'verifier-state' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(verifier));
        assert.match(error.message, /\[redacted\]/u);
        return true;
      },
    );
  });

  test('a refresh landing after logout cannot resurrect the record, even mid-write', async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const fixture = await createOAuthFixture({
      holdRefresh: () => {
        markRefreshStarted();
        return refreshGate;
      },
    });
    const memory = createMemoryMcpOAuthStorage();
    // A storage whose writes take real time — the window the check-then-act
    // race needs: the epoch check passes, then logout lands mid-write. The
    // flags pin the interleaving: without them a loaded runner could let the
    // write finish first and the test would silently stop covering the race
    // its name describes.
    let writeInFlight = false;
    let logoutLandedMidWrite = false;
    const slow: McpOAuthStorage = {
      get: (id) => memory.get(id),
      set: async (id, record) => {
        writeInFlight = true;
        await new Promise((resolve) => setTimeout(resolve, 120));
        writeInFlight = false;
        await memory.set(id, record);
      },
      delete: (id) => memory.delete(id),
    };
    await memory.set('remote', {
      serverUrl: fixture.mcpUrl,
      clientInformation: { client_id: 'stored-client' },
      tokens: {
        access_token: 'stale-token',
        token_type: 'Bearer',
        refresh_token: fixture.refreshToken,
      },
    });
    const manager = new McpClientManager({ oauthStorage: slow });
    managers.push(manager);

    const syncing = manager.sync(config(fixture.mcpUrl));
    await refreshStarted;
    releaseRefresh();
    // Wait until saveTokens has provably passed the guard check and entered
    // its slow write — polling the flag pins the interleaving the test's
    // name promises, instead of hoping a fixed sleep lands inside it.
    const writeEntered = Date.now() + 5_000;
    while (!writeInFlight && Date.now() < writeEntered) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    logoutLandedMidWrite = writeInFlight;
    const clearing = manager.clearAuthorization('remote');
    await Promise.allSettled([syncing, clearing]);

    assert.equal(logoutLandedMidWrite, true);
    assert.equal((await memory.get('remote'))?.tokens, undefined);
  });

  test('a raw 401 keeps its code through the scrubbed refreshTools rejection', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));
    assert.equal(manager.status('remote')?.state, 'connected');

    fixture.rotateAccessToken();
    await assert.rejects(manager.refreshTools('remote'), (error: unknown) => {
      assert.ok(error instanceof Error);
      // The scrub must not strip the auth signal: the notification handler
      // (and any caller) still needs to recognize the 401.
      const code = (error as { code?: unknown }).code;
      assert.ok(code === 401 || /Unauthorized|McpAuthRequired/u.test(error.name));
      return true;
    });
    // The public refresh path is the same authorization loss as the
    // notification path: the server leaves `connected` and its stale
    // snapshot stops being callable, instead of surviving the throw.
    assert.equal(manager.status('remote')?.state, 'needs-auth');
    assert.ok(!manager.toolSnapshot().tools.some((tool) => tool.descriptor.serverId === 'remote'));
  });

  test('a token endpoint reflecting the authorization code does not leak it', async () => {
    const fixture = await createOAuthFixture({ reflectCodeInTokenError: true });
    const manager = new McpClientManager({ oauthStorage: createMemoryMcpOAuthStorage() });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39993/callback', {
      state: 'code-reflect-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    const consent = await fetch(start.authorizationUrl, { redirect: 'manual' });
    const code = new URL(consent.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);

    await assert.rejects(
      manager.finishAuthorization('remote', { code, state: 'code-reflect-state' }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(code));
        assert.match(error.message, /\[redacted\]/u);
        return true;
      },
    );
  });

  test('a stored OAuth session excludes a configured Authorization header', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        remote: {
          url: fixture.mcpUrl,
          transport: 'streamable-http',
          // No oauth block (the store rejects that conflict outright), but a
          // stored session exists: the bearer owns Authorization, and the
          // configured header must not override the fresh token.
          headers: { Authorization: 'Bearer stale-configured-header' },
        },
      },
    });
    assert.equal(manager.status('remote')?.state, 'connected');
    assert.ok(
      fixture.mcpRequests.some((req) => req.authorization === `Bearer ${fixture.accessToken}`),
    );
    assert.ok(
      !fixture.mcpRequests.some((req) => req.authorization === 'Bearer stale-configured-header'),
    );
  });

  test('the callback iss parameter reaches the SDK issuer validation', async () => {
    const fixture = await createOAuthFixture({ issueIss: true });
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39992/callback', {
      state: 'iss-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    const consent = await fetch(start.authorizationUrl, { redirect: 'manual' });
    const location = new URL(consent.headers.get('location') ?? '');
    const code = location.searchParams.get('code');
    const iss = location.searchParams.get('iss');
    assert.ok(code);
    assert.ok(iss);

    // The genuine issuer passes...
    const status = await manager.finishAuthorization('remote', { code, iss, state: 'iss-state' });
    assert.equal(status.state, 'connected');
  });

  test('a forged callback iss is rejected before the code is redeemed', async () => {
    const fixture = await createOAuthFixture({ issueIss: true });
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39991/callback', {
      state: 'forged-iss-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    const consent = await fetch(start.authorizationUrl, { redirect: 'manual' });
    const code = new URL(consent.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);

    await assert.rejects(
      manager.finishAuthorization('remote', {
        code,
        iss: 'https://evil.example',
        state: 'forged-iss-state',
      }),
    );
    // The mix-up defense fired: no tokens were minted for the forged issuer.
    assert.equal((await storage.get('remote'))?.tokens, undefined);
  });

  test('every credential transition stamps a monotonically increasing version', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39990/callback', {
      state: 'version-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    const consent = await fetch(start.authorizationUrl, { redirect: 'manual' });
    const code = new URL(consent.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);
    await manager.finishAuthorization('remote', { code, state: 'version-state' });

    const record = await storage.get('remote');
    assert.ok(record?.tokens);
    assert.ok(typeof record.version === 'number' && record.version >= 2);
  });

  test('a CAS-capable backend surfaces external-writer conflicts instead of clobbering', async () => {
    const fixture = await createOAuthFixture();
    const memory = createMemoryMcpOAuthStorage();
    let tokenWriteConflicts = 0;
    // Backend with compare-and-set: pre-token transitions (discovery,
    // verifier) commit normally; the token write reports that another
    // process changed the record between our read and write.
    const storage: McpOAuthStorage = {
      get: (serverId) => memory.get(serverId),
      set: (serverId, record) => memory.set(serverId, record),
      delete: (serverId) => memory.delete(serverId),
      compareAndSet: async (serverId, _expectedVersion, record) => {
        if (record.tokens) {
          tokenWriteConflicts += 1;
          return 'conflict';
        }
        await memory.set(serverId, record);
        return 'committed';
      },
    };
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39990/callback', {
      state: 'cas-conflict-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    const consent = await fetch(start.authorizationUrl, { redirect: 'manual' });
    const code = new URL(consent.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);
    // The exchange must refuse to overwrite the externally changed record —
    // and the conflict proves CAS survives the manager's storage wrapper.
    await assert.rejects(
      manager.finishAuthorization('remote', { code, state: 'cas-conflict-state' }),
      /outside/u,
    );
    assert.ok(tokenWriteConflicts >= 1);
    assert.equal((await memory.get('remote'))?.tokens, undefined);
  });

  test('a removed server or a changed URL forgets its stored authorization', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));
    assert.equal(manager.status('remote')?.state, 'connected');

    // A URL edit must not replay the old endpoint's bearer token against the
    // new one. Disabled so the sync does not try to reach the fake host.
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        remote: {
          url: 'https://changed.example/mcp',
          transport: 'streamable-http',
          enabled: false,
        },
      },
    });
    // Erase is a tombstone, not an absence: the credentials are gone and
    // the persisted generation advanced, so a raced flow in ANOTHER process
    // (which cannot see this one's epoch) is fenced too.
    const afterUrlChange = await storage.get('remote');
    assert.equal(afterUrlChange?.tokens, undefined);
    assert.equal(afterUrlChange?.clientInformation, undefined);
    assert.equal(afterUrlChange?.generation, 1);

    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      generation: 1,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    await manager.sync({ version: MCP_CONFIG_VERSION, mcpServers: {} });
    const afterRemoval = await storage.get('remote');
    assert.equal(afterRemoval?.tokens, undefined);
    assert.equal(afterRemoval?.generation, 2);
  });

  test('a failed credential erase blocks the server instead of releasing it', async () => {
    const fixture = await createOAuthFixture();
    const memory = createMemoryMcpOAuthStorage();
    await memory.set('remote', {
      serverUrl: fixture.mcpUrl,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    let storageDown = false;
    const flaky: McpOAuthStorage = {
      get: (id) => memory.get(id),
      set: async (id, record) => {
        if (storageDown) throw new Error('credential store unavailable');
        await memory.set(id, record);
      },
      delete: async (id) => {
        if (storageDown) throw new Error('credential store unavailable');
        await memory.delete(id);
      },
    };
    const manager = new McpClientManager({ oauthStorage: flaky });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));
    assert.equal(manager.status('remote')?.state, 'connected');

    // URL change while the credential store is down: the erase is a
    // prerequisite, so the new endpoint must NOT take ownership — and the
    // caller that just wrote the config gets the failure instead of a
    // clean resolve that hides the divergence.
    storageDown = true;
    await assert.rejects(
      manager.sync({
        version: MCP_CONFIG_VERSION,
        mcpServers: {
          remote: { url: 'https://changed.example/mcp', transport: 'streamable-http' },
        },
      }),
      /credential store unavailable/u,
    );
    assert.equal(manager.status('remote')?.state, 'error');
    assert.match(manager.status('remote')?.error ?? '', /could not be removed/u);
    // The blocked entry is not connectable — neither the old token nor the
    // new endpoint is reachable through it.
    await assert.rejects(manager.connect('remote'), /blocked/u);
    // The old credentials still exist (the erase failed); nothing adopted
    // the new endpoint while they do.
    assert.ok((await memory.get('remote'))?.tokens);

    // Removal with the store still down: the sync rejects, the entry stays
    // blocked, and a same-id reconnect is refused rather than reusing the
    // surviving record.
    await assert.rejects(
      manager.sync({ version: MCP_CONFIG_VERSION, mcpServers: {} }),
      /unavailable/u,
    );
    await assert.rejects(manager.connect('remote'), /blocked/u);

    // Store recovers: the next sync retires the credentials, and only then
    // does the new endpoint take over.
    storageDown = false;
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        remote: {
          url: 'https://changed.example/mcp',
          transport: 'streamable-http',
          enabled: false,
        },
      },
    });
    const record = await memory.get('remote');
    assert.equal(record?.tokens, undefined);
    assert.equal(record?.generation, 1);
    assert.equal(manager.status('remote')?.state, 'disabled');
  });

  test('the interactive flow never sends a configured Authorization header', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        remote: {
          url: fixture.mcpUrl,
          transport: 'streamable-http',
          enabled: false,
          headers: { Authorization: 'Bearer stale-configured-header' },
        },
      },
    });
    const before = fixture.mcpRequests.length;

    // The whole interactive round — probe, discovery, exchange — owns
    // Authorization; the configured header stays out of every request.
    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39994/callback', {
      state: 'exclusivity-state',
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    const consent = await fetch(start.authorizationUrl, { redirect: 'manual' });
    const code = new URL(consent.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);
    await manager.finishAuthorization('remote', { code, state: 'exclusivity-state' }).catch(() => {
      // The reconnect after the exchange may fail (server disabled); the
      // requests the round itself made are what this test inspects.
    });
    const during = fixture.mcpRequests.slice(before);
    assert.ok(during.length > 0);
    assert.ok(!during.some((req) => req.authorization === 'Bearer stale-configured-header'));
  });

  test('a logout in another process fences this process’s in-flight refresh', async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    const fixture = await createOAuthFixture({
      holdRefresh: () => {
        markRefreshStarted();
        return refreshGate;
      },
    });
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: fixture.mcpUrl,
      clientInformation: { client_id: 'stored-client' },
      tokens: {
        access_token: 'stale-token',
        token_type: 'Bearer',
        refresh_token: fixture.refreshToken,
      },
    });
    // Two managers over ONE storage = two processes. B's in-memory epoch
    // never sees A's logout; only the persisted generation can fence it.
    const managerB = new McpClientManager({ oauthStorage: storage });
    const managerA = new McpClientManager({ oauthStorage: storage });
    managers.push(managerB, managerA);

    const syncing = managerB.sync(config(fixture.mcpUrl));
    await refreshStarted;
    const disabled = config(fixture.mcpUrl);
    for (const server of Object.values(disabled.mcpServers)) server.enabled = false;
    await managerA.sync(disabled);
    await managerA.forgetServerCredentials('remote');

    releaseRefresh();
    await syncing.catch(() => {});

    // B's refresh completed at the token endpoint, but its write was
    // refused: the tombstone stands and the tokens are NOT resurrected.
    const record = await storage.get('remote');
    assert.equal(record?.tokens, undefined);
    assert.equal(record?.generation, 1);
  });

  test('a credential record with no endpoint binding is revoked, not adopted', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    // Legacy/hand-written record: credential material, no serverUrl.
    await storage.set('remote', {
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
      clientInformation: { client_id: 'stored-client' },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));

    // Provenance cannot be established after the fact: the record must not
    // have been used, and it must be gone — the user logs in again.
    assert.equal(manager.status('remote')?.state, 'needs-auth');
    const record = await storage.get('remote');
    assert.equal(record?.tokens, undefined);
    assert.equal(record?.clientInformation, undefined);
    assert.ok(
      !fixture.mcpRequests.some((req) => req.authorization === `Bearer ${fixture.accessToken}`),
    );
  });

  test('a superseded authorization round cannot finish with the older verifier', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));

    // Round 1 starts and its browser leg completes…
    const first = await manager.startAuthorization('remote', 'http://127.0.0.1:39996/callback', {
      state: 'round-one',
    });
    assert.equal(first.status, 'redirect');
    if (first.status !== 'redirect') return;
    const firstConsent = await fetch(first.authorizationUrl, { redirect: 'manual' });
    const firstCode = new URL(firstConsent.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(firstCode);

    // …but round 2 starts before round 1 finishes, overwriting the pending
    // verifier. Round 1's finish must be refused — exchanging its code
    // against round 2's PKCE verifier could not succeed and must not try.
    const second = await manager.startAuthorization('remote', 'http://127.0.0.1:39997/callback', {
      state: 'round-two',
    });
    assert.equal(second.status, 'redirect');
    if (second.status !== 'redirect') return;
    await assert.rejects(
      manager.finishAuthorization('remote', { code: firstCode, state: 'round-one' }),
      /superseded/u,
    );

    // Round 2 completes normally.
    const secondConsent = await fetch(second.authorizationUrl, { redirect: 'manual' });
    const secondCode = new URL(secondConsent.headers.get('location') ?? '').searchParams.get(
      'code',
    );
    assert.ok(secondCode);
    const status = await manager.finishAuthorization('remote', {
      code: secondCode,
      state: 'round-two',
    });
    assert.equal(status.state, 'connected');
  });

  test('a discovery that moves to another authorization server drops the registered client', async () => {
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: 'https://mcp.example/mcp',
      clientInformation: { client_id: 'as-a-client', client_secret: 'as-a-secret' },
      tokens: { access_token: 'as-a-token', token_type: 'Bearer' },
      discovery: { authorizationServerUrl: 'https://as-a.example' } as never,
    });
    const provider = new McpOAuthProvider({
      serverId: 'remote',
      serverUrl: 'https://mcp.example/mcp',
      storage,
      clientName: 'maka',
      clientVersion: '0.0.0',
    });
    await provider.saveDiscoveryState({
      authorizationServerUrl: 'https://as-b.example',
    } as never);
    const record = await storage.get('remote');
    // One client per issuer: AS-A's registration (and its tokens) must not
    // be presented to AS-B.
    assert.equal(record?.clientInformation, undefined);
    assert.equal(record?.tokens, undefined);
    assert.ok(record?.discovery);
  });

  test('an atomic update cannot rebind another endpoint’s material to this one', async () => {
    // Offline mcp.json repoint with SAME discovery issuer: the update path
    // must apply read()'s fail-closed binding to its basis, or the old
    // endpoint's tokens/client/discovery ride into the re-stamped record.
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: 'https://old.example/mcp',
      clientInformation: { client_id: 'old-client', client_secret: 'old-secret' },
      tokens: { access_token: 'old-token', token_type: 'Bearer' },
      discovery: { authorizationServerUrl: 'https://as.example' } as never,
      generation: 3,
      version: 7,
    });
    const provider = new McpOAuthProvider({
      serverId: 'remote',
      serverUrl: 'https://new.example/mcp',
      storage: withUpdate(storage),
      clientName: 'maka',
      clientVersion: '0.0.0',
    });
    // First write of a fresh round against the NEW endpoint (same issuer).
    await provider.saveDiscoveryState({
      authorizationServerUrl: 'https://as.example',
    } as never);
    const record = await storage.get('remote');
    assert.equal(record?.serverUrl, 'https://new.example/mcp');
    assert.equal(record?.tokens, undefined);
    assert.equal(record?.clientInformation, undefined);
    assert.ok(record?.discovery);
    // Coordinator bookkeeping survives the strip.
    assert.equal(record?.generation, 3);
  });

  test('a logout during the pre-write probe fences the whole flow', async () => {
    // Process B pins its flow, then process A logs out while B is still in
    // its remote probe (before B's first write). B's later writes must be
    // refused: the pinned generation predates the tombstone.
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('remote', {
      serverUrl: 'https://mcp.example/mcp',
      tokens: { access_token: 'live', token_type: 'Bearer' },
    });
    const managerB = new McpClientManager({ oauthStorage: storage });
    const managerA = new McpClientManager({ oauthStorage: storage });
    managers.push(managerB, managerA);
    const config: McpConfigFile = {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        remote: { url: 'https://mcp.example/mcp', transport: 'streamable-http', enabled: false },
      },
    };
    await managerB.sync(config);
    await managerA.sync(config);

    // B pins its flow (beginFlow semantics), then A tombstones.
    const flowB = await (
      managerB as unknown as {
        beginFlow(serverId: string): Promise<import('../oauth.js').McpOAuthStorage>;
      }
    ).beginFlow('remote');
    await managerA.forgetServerCredentials('remote');

    await assert.rejects(
      flowB.set('remote', {
        serverUrl: 'https://mcp.example/mcp',
        codeVerifier: 'late-round-verifier',
      }),
      /revoked/u,
    );
    const record = await storage.get('remote');
    assert.equal(record?.codeVerifier, undefined);
    assert.equal(record?.generation, 1);
  });

  test('a callback that omits state cannot skip the round binding', async () => {
    // The pending record ALWAYS carries a state (minted when the caller
    // supplies none); the binding keys off the record, so an attacker-
    // submitted callback with no state does not bypass verification.
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));

    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39989/callback', {});
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    // Minted and persisted even though the caller supplied none.
    assert.ok(start.state);
    assert.equal((await storage.get('remote'))?.pendingState, start.state);

    await assert.rejects(
      manager.finishAuthorization('remote', { code: 'attacker-code' }),
      /superseded by a newer login/u,
    );
  });

  test('a superseded abandon leaves the newer round’s verifier and state intact', async () => {
    // Round A dies and its abandon is queued; before the clearing write
    // lands, round B persists a fresh verifier/state. A's abandon must
    // become a no-op instead of CAS-deleting B's pending round.
    const rounds: McpOAuthRecord[] = [
      { version: 3, codeVerifier: 'round-a-verifier', pendingState: 'round-a-state' },
      { version: 4, codeVerifier: 'round-b-verifier', pendingState: 'round-b-state' },
    ];
    let stored = rounds[0] as McpOAuthRecord;
    let reads = 0;
    const storage: McpOAuthStorage = {
      get: async () => {
        reads += 1;
        // The abandon's decision read sees round A; by the time its
        // clearing write reads its basis, round B has landed.
        if (reads === 2) stored = rounds[1] as McpOAuthRecord;
        return stored;
      },
      set: async (_id, record) => {
        stored = record;
      },
      delete: async () => {},
    };
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);

    await manager.abandonAuthorization('remote');

    assert.equal(stored.codeVerifier, 'round-b-verifier');
    assert.equal(stored.pendingState, 'round-b-state');
    assert.equal(stored.version, 4);
  });

  test('removal erases a stale credential record even when the server became stdio', async () => {
    // An offline mcp.json edit converted a credentialed remote server to
    // stdio. Removing it must still retire the old endpoint's record —
    // otherwise a same-id remote re-add at the old URL inherits the token.
    const storage = createMemoryMcpOAuthStorage();
    await storage.set('convert', {
      serverUrl: 'https://old.example/mcp',
      tokens: { access_token: 'stale-token', token_type: 'Bearer' },
    });
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync({
      version: MCP_CONFIG_VERSION,
      mcpServers: { convert: { command: 'node', enabled: false } },
    });

    await manager.sync({ version: MCP_CONFIG_VERSION, mcpServers: {} });

    const record = await storage.get('convert');
    assert.equal(record?.tokens, undefined);
    assert.ok((record?.generation ?? 0) >= 1);
  });

  test('interactive authorization fails closed while credential cleanup is owed', async () => {
    const fixture = await createOAuthFixture();
    const memory = createMemoryMcpOAuthStorage();
    await memory.set('remote', {
      serverUrl: fixture.mcpUrl,
      tokens: { access_token: fixture.accessToken, token_type: 'Bearer' },
    });
    let storageDown = false;
    const flaky: McpOAuthStorage = {
      get: (id) => memory.get(id),
      set: async (id, record) => {
        if (storageDown) throw new Error('credential store unavailable');
        await memory.set(id, record);
      },
      delete: async (id) => {
        if (storageDown) throw new Error('credential store unavailable');
        await memory.delete(id);
      },
    };
    const manager = new McpClientManager({ oauthStorage: flaky });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));
    storageDown = true;
    await assert.rejects(
      manager.sync({
        version: MCP_CONFIG_VERSION,
        mcpServers: {
          remote: { url: 'https://changed.example/mcp', transport: 'streamable-http' },
        },
      }),
      /credential store unavailable/u,
    );
    assert.match(manager.status('remote')?.error ?? '', /could not be removed/u);
    // Not just connect(): the interactive paths fail closed too.
    await assert.rejects(
      manager.startAuthorization('remote', 'http://127.0.0.1:39998/callback', { state: 's' }),
      /blocked/u,
    );
    await assert.rejects(
      manager.finishAuthorization('remote', { code: 'x', state: 's' }),
      /blocked/u,
    );
    await assert.rejects(manager.clearAuthorization('remote'), /blocked/u);
  });

  test('an aborted round cannot exchange its code or write credentials', async () => {
    const fixture = await createOAuthFixture();
    const storage = createMemoryMcpOAuthStorage();
    const manager = new McpClientManager({ oauthStorage: storage });
    managers.push(manager);
    await manager.sync(config(fixture.mcpUrl));

    const round = new AbortController();
    const start = await manager.startAuthorization('remote', 'http://127.0.0.1:39995/callback', {
      state: 'abort-state',
      signal: round.signal,
    });
    assert.equal(start.status, 'redirect');
    if (start.status !== 'redirect') return;
    const consent = await fetch(start.authorizationUrl, { redirect: 'manual' });
    const code = new URL(consent.headers.get('location') ?? '').searchParams.get('code');
    assert.ok(code);

    // The round's owner timed out and abandoned it; the late completion
    // must neither exchange the code nor land any write.
    round.abort();
    const exchanges = fixture.tokenExchanges.length;
    await assert.rejects(
      manager.finishAuthorization(
        'remote',
        { code, state: 'abort-state' },
        { signal: round.signal },
      ),
      /abandoned|abort/iu,
    );
    assert.equal(fixture.tokenExchanges.length, exchanges);
    assert.equal((await storage.get('remote'))?.tokens, undefined);
  });
});

/** Memory storage with the coordinator-style atomic update, so provider
 * tests exercise the update path rather than the read+set fallback. */
function withUpdate(storage: McpOAuthStorage): McpOAuthStorage {
  return {
    ...storage,
    update: async (serverId, apply) => {
      const basis = (await storage.get(serverId)) ?? {};
      const next = apply({ ...basis });
      await storage.set(serverId, next);
      return next;
    },
  };
}

function bindingFor(manager: McpClientManager, serverId: string, toolName: string) {
  const bound = manager
    .toolSnapshot()
    .tools.find(
      (tool) => tool.descriptor.serverId === serverId && tool.descriptor.name === toolName,
    );
  if (!bound) throw new Error(`no binding for ${serverId}/${toolName}`);
  return bound.binding;
}

function config(url: string): McpConfigFile {
  return {
    version: MCP_CONFIG_VERSION,
    mcpServers: { remote: { url, transport: 'streamable-http' } },
  };
}

interface OAuthFixture {
  mcpUrl: string;
  accessToken: string;
  refreshToken: string;
  mcpRequests: Array<{ authorization?: string }>;
  registrations: unknown[];
  tokenExchanges: Array<{ pkceVerified: boolean }>;
  /** Invalidates every issued access token, like a server-side revocation. */
  rotateAccessToken(): void;
  close(): Promise<void>;
}

async function createOAuthFixture(
  options: {
    reflectInTokenError?: string;
    /** Makes POST /mcp fail with this body — a server reflecting what it
     * was sent (the Authorization header) into an error. */
    mcpFailureBody?: (authorization?: string) => string;
    /** 405 on unauthenticated GET; only the initialize POST answers 401 —
     * a legal Streamable HTTP shape the challenge probe must handle. */
    challengeOnPostOnly?: boolean;
    /** Awaited before answering a refresh_token grant, so a test can land
     * a logout in the middle of the refresh. */
    holdRefresh?: () => Promise<void>;
    /** In challengeOnPostOnly mode, 400 any initialize that does not carry
     * the SDK's current protocol version — the strict-server shape that
     * broke a pinned probe version. */
    requireProtocolVersion?: string;
    /** GET answers 401 with a bare challenge (no parameters); only POST
     * carries scope/metadata. */
    bareChallengeOnGet?: boolean;
    /** The protocol server reflects the last HTTP Authorization it saw
     * into tool descriptions, results and structuredContent. */
    reflectAuthInProtocol?: boolean;
    /** The token endpoint reflects the code_verifier it received into
     * error_description. */
    reflectVerifierInTokenError?: boolean;
    /** The consent redirect carries an RFC 9207 `iss` parameter. */
    issueIss?: boolean;
    /** The token endpoint reflects the authorization code it received into
     * error_description. */
    reflectCodeInTokenError?: boolean;
  } = {},
): Promise<OAuthFixture> {
  let accessToken = `token-${randomUUID()}`;
  let lastAuthorization = '';
  const refreshToken = `refresh-${randomUUID()}`;
  const mcpRequests: Array<{ authorization?: string }> = [];
  const registrations: unknown[] = [];
  const tokenExchanges: Array<{ pkceVerified: boolean }> = [];
  const pendingCodes = new Map<string, { challenge: string; redirectUri: string }>();
  let origin = '';

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    try {
      if (url.pathname === '/mcp') {
        const authorization = req.headers.authorization;
        if (typeof authorization === 'string') lastAuthorization = authorization;
        mcpRequests.push(typeof authorization === 'string' ? { authorization } : {});
        if (options.bareChallengeOnGet && req.method === 'GET') {
          res.writeHead(401, { 'www-authenticate': 'Bearer realm="mcp"' }).end();
          return;
        }
        if (options.challengeOnPostOnly && req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        if (options.requireProtocolVersion && req.method === 'POST') {
          const body = (await readJsonBody(req)) as
            | { method?: string; params?: { protocolVersion?: string } }
            | undefined;
          if (
            body?.method === 'initialize' &&
            body.params?.protocolVersion !== options.requireProtocolVersion
          ) {
            res
              .writeHead(400, { 'content-type': 'application/json' })
              .end('{"error":"bad version"}');
            return;
          }
          if (authorization !== `Bearer ${accessToken}`) {
            res
              .writeHead(401, {
                'content-type': 'application/json',
                'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="files:read"`,
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
          await transport.handleRequest(req, res, body);
          return;
        }
        if (options.mcpFailureBody) {
          res
            .writeHead(500, { 'content-type': 'text/plain' })
            .end(
              options.mcpFailureBody(typeof authorization === 'string' ? authorization : undefined),
            );
          return;
        }
        if (authorization !== `Bearer ${accessToken}`) {
          res
            .writeHead(401, {
              'content-type': 'application/json',
              'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="files:read"`,
            })
            .end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const server = createProtocolServer(
          options.reflectAuthInProtocol ? () => lastAuthorization : undefined,
        );
        await server.connect(transport);
        res.once('close', () => {
          void transport.close();
          void server.close();
        });
        await transport.handleRequest(req, res, await readJsonBody(req));
        return;
      }
      if (url.pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
        json(res, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        return;
      }
      if (url.pathname === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
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
        registrations.push(body);
        json(res, {
          client_id: `client-${registrations.length}`,
          redirect_uris: body.redirect_uris,
          token_endpoint_auth_method: 'none',
        });
        return;
      }
      if (url.pathname === '/authorize' && req.method === 'GET') {
        const challenge = url.searchParams.get('code_challenge');
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        if (!challenge || !redirectUri) {
          res.writeHead(400).end('missing challenge or redirect_uri');
          return;
        }
        const code = `code-${randomUUID()}`;
        pendingCodes.set(code, { challenge, redirectUri });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        if (state) target.searchParams.set('state', state);
        if (options.issueIss) target.searchParams.set('iss', origin);
        res.writeHead(302, { location: target.toString() }).end();
        return;
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const params = new URLSearchParams(await readTextBody(req));
        if (options.reflectCodeInTokenError) {
          json(
            res,
            {
              error: 'invalid_grant',
              error_description: `code rejected ${params.get('code') ?? ''}`,
            },
            400,
          );
          return;
        }
        if (options.reflectVerifierInTokenError) {
          json(
            res,
            {
              error: 'invalid_grant',
              error_description: `verifier rejected ${params.get('code_verifier') ?? ''}`,
            },
            400,
          );
          return;
        }
        if (options.reflectInTokenError) {
          // A hostile or buggy token endpoint echoing what it was sent.
          json(
            res,
            {
              error: 'invalid_grant',
              error_description: `server rejected credential ${options.reflectInTokenError}`,
            },
            400,
          );
          return;
        }
        if (params.get('grant_type') === 'refresh_token') {
          if (params.get('refresh_token') !== refreshToken) {
            json(res, { error: 'invalid_grant' }, 400);
            return;
          }
          if (options.holdRefresh) await options.holdRefresh();
          json(res, {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 3600,
            refresh_token: refreshToken,
          });
          return;
        }
        const pending = pendingCodes.get(params.get('code') ?? '');
        const verifier = params.get('code_verifier') ?? '';
        const hashed = createHash('sha256').update(verifier).digest('base64url');
        const pkceVerified = Boolean(pending && hashed === pending.challenge);
        tokenExchanges.push({ pkceVerified });
        if (!pkceVerified) {
          json(res, { error: 'invalid_grant' }, 400);
          return;
        }
        json(res, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: refreshToken,
        });
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

  const fixture: OAuthFixture = {
    mcpUrl: `${origin}/mcp`,
    get accessToken() {
      return accessToken;
    },
    refreshToken,
    mcpRequests,
    registrations,
    tokenExchanges,
    rotateAccessToken: () => {
      accessToken = `token-${randomUUID()}`;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections();
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  fixtures.push(fixture);
  return fixture;
}

function createProtocolServer(reflect?: () => string): McpServer {
  const server = new McpServer(
    { name: 'maka-oauth-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        // A server echoing the credential it was just sent — into the tool
        // metadata the client persists.
        description: reflect ? `Echo text (${reflect()})` : 'Echo text',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
    content: [
      {
        type: 'text',
        text: `${String(params.arguments?.value ?? '')}${reflect ? ` ${reflect()}` : ''}`,
      },
    ],
    structuredContent: reflect ? { reflected: reflect(), [reflect()]: 'present' } : undefined,
  }));
  return server;
}

function json(res: import('node:http').ServerResponse, body: unknown, status = 200): void {
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
