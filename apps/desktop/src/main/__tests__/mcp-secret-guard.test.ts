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
import { describe, it } from 'node:test';
import { MCP_CONFIG_VERSION, type McpConfigFile } from '@maka/core/mcp';
import {
  mcpSecretMarker,
  McpSecretRestoreError,
  redactMcpConfigSecrets,
  restoreMcpConfigSecrets,
  restoreMcpServerSecret,
} from '../mcp-secret-guard.js';

const withSecret = (secret?: string): McpConfigFile => ({
  version: MCP_CONFIG_VERSION,
  mcpServers: {
    notion: {
      url: 'https://mcp.notion.com/mcp',
      transport: 'streamable-http',
      ...(secret ? { oauth: { clientId: 'abc', clientSecret: secret } } : { oauth: { clientId: 'abc' } }),
    },
    local: { command: 'npx', args: ['server'] },
  },
});

describe('MCP secret redaction', () => {
  it('masks all remote header values and restores them only for the same URL', () => {
    const previous: McpConfigFile = {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        api: {
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer live-token', 'X-Workspace': 'ws-1' },
        },
      },
    };
    const redacted = redactMcpConfigSecrets(previous);
    const server = redacted.mcpServers.api;
    assert.ok(server && 'url' in server);
    // Every header value is credential-position: masked, keys readable.
    assert.deepEqual(server.headers, {
      Authorization: mcpSecretMarker('header.Authorization'),
      'X-Workspace': mcpSecretMarker('header.X-Workspace'),
    });

    const restored = restoreMcpConfigSecrets(redacted, previous);
    const restoredServer = restored.mcpServers.api;
    assert.ok(restoredServer && 'url' in restoredServer);
    assert.deepEqual(restoredServer.headers, {
      Authorization: 'Bearer live-token',
      'X-Workspace': 'ws-1',
    });

    // A renderer that kept the sentinel but repointed the URL is rejected —
    // silently dropping the headers would destroy stored values unnoticed.
    const repointed = structuredClone(redacted);
    const repointedServer = repointed.mcpServers.api;
    assert.ok(repointedServer && 'url' in repointedServer);
    repointedServer.url = 'https://attacker.example/mcp';
    assert.throws(() => restoreMcpConfigSecrets(repointed, previous), McpSecretRestoreError);
  });

  it('treats an unnormalized stored URL as the same endpoint', () => {
    // mcp.json may carry a hand-written URL WHATWG would normalize (no path
    // slash). The redacted round-trip normalizes; the identity comparison
    // must not read that as an endpoint change and reject the restore.
    const previous: McpConfigFile = {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        api: {
          url: 'https://api.example.com?api_key=qk-1',
          headers: { Authorization: 'Bearer live-token' },
          oauth: { clientId: 'abc', clientSecret: 'real-secret' },
        },
      },
    };
    const redacted = redactMcpConfigSecrets(previous);
    const restored = restoreMcpConfigSecrets(redacted, previous);
    const server = restored.mcpServers.api;
    assert.ok(server && 'url' in server);
    assert.deepEqual(server.headers, { Authorization: 'Bearer live-token' });
    assert.equal(server.oauth?.clientSecret, 'real-secret');
    assert.equal(new URL(server.url).searchParams.get('api_key'), 'qk-1');
  });

  it('masks every stdio env value and binds restore to the whole launch basis', () => {
    const previous: McpConfigFile = {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        local: {
          command: 'npx',
          args: ['server'],
          cwd: '/srv/app',
          env: { PGPASSWORD: 'pg-secret', NODE_ENV: 'production' },
        },
      },
    };
    const redacted = redactMcpConfigSecrets(previous);
    const server = redacted.mcpServers.local;
    assert.ok(server && 'command' in server);
    // No key heuristic: PGPASSWORD would not match one, so every value is
    // masked — the boundary is absolute.
    assert.deepEqual(server.env, {
      PGPASSWORD: mcpSecretMarker('env.PGPASSWORD'),
      NODE_ENV: mcpSecretMarker('env.NODE_ENV'),
    });

    const restored = restoreMcpConfigSecrets(redacted, previous);
    const restoredServer = restored.mcpServers.local;
    assert.ok(restoredServer && 'command' in restoredServer);
    assert.deepEqual(restoredServer.env, { PGPASSWORD: 'pg-secret', NODE_ENV: 'production' });

    // Changing ANY part of the launch basis — command, cwd, or another env
    // value — rejects the write: an ordinary edit must never silently
    // delete every stored env value.
    for (const mutate of [
      (s: Record<string, unknown>) => {
        s.command = 'curl';
      },
      (s: Record<string, unknown>) => {
        s.cwd = '/tmp';
      },
      (s: Record<string, unknown>) => {
        (s.env as Record<string, string>).NODE_ENV = 'test';
      },
    ]) {
      const repointed = structuredClone(redacted);
      const target = repointed.mcpServers.local as unknown as Record<string, unknown>;
      mutate(target);
      assert.throws(() => restoreMcpConfigSecrets(repointed, previous), McpSecretRestoreError);
    }
  });

  it('masks credential-bearing args and binds their restore to the command line', () => {
    // `--custom` is not a sensitive name — the VALUE is what marks it: a
    // pattern-recognized token behind any flag prefix must mask too.
    const priorArgs = [
      'server',
      '--token',
      'tok-abc123',
      '--api-key=key-xyz789',
      '--custom=sk-ant-api03-abcdef123456',
      '--verbose',
    ];
    const previous: McpConfigFile = {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        local: { command: 'npx', args: priorArgs },
      },
    };
    const redacted = redactMcpConfigSecrets(previous);
    const server = redacted.mcpServers.local;
    assert.ok(server && 'command' in server);
    assert.deepEqual(server.args, [
      'server',
      '--token',
      mcpSecretMarker('arg.2'),
      `--api-key=${mcpSecretMarker('argflag.3')}`,
      `--custom=${mcpSecretMarker('argflag.4')}`,
      '--verbose',
    ]);

    const restored = restoreMcpConfigSecrets(redacted, previous);
    const restoredServer = restored.mcpServers.local;
    assert.ok(restoredServer && 'command' in restoredServer);
    assert.deepEqual(restoredServer.args, priorArgs);

    // A repointed command rejects: dropping the bare sentinel would leave
    // its introducing flag consuming the next argument (`--token --verbose`).
    const repointed = structuredClone(redacted);
    const repointedServer = repointed.mcpServers.local;
    assert.ok(repointedServer && 'command' in repointedServer);
    repointedServer.command = 'curl';
    assert.throws(() => restoreMcpConfigSecrets(repointed, previous), McpSecretRestoreError);
  });

  it('masks sensitive URL query values and binds their restore to the rest of the URL', () => {
    const previous: McpConfigFile = {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        api: {
          url: 'https://api.example.com/mcp?api_key=qk-secret-1&region=eu',
        },
      },
    };
    const redacted = redactMcpConfigSecrets(previous);
    const server = redacted.mcpServers.api;
    assert.ok(server && 'url' in server);
    const maskedUrl = new URL(server.url);
    assert.equal(maskedUrl.searchParams.get('api_key'), mcpSecretMarker('query.api_key.0'));
    assert.equal(maskedUrl.searchParams.get('region'), 'eu');

    const restored = restoreMcpConfigSecrets(redacted, previous);
    const restoredServer = restored.mcpServers.api;
    assert.ok(restoredServer && 'url' in restoredServer);
    assert.equal(new URL(restoredServer.url).searchParams.get('api_key'), 'qk-secret-1');

    // Same sentinel, different path — the write is rejected.
    const repointed = structuredClone(redacted);
    const repointedServer = repointed.mcpServers.api;
    assert.ok(repointedServer && 'url' in repointedServer);
    repointedServer.url = repointedServer.url.replace('/mcp', '/exfil');
    assert.throws(() => restoreMcpConfigSecrets(repointed, previous), McpSecretRestoreError);
  });

  it('treats cosmetic query-encoding differences as the same endpoint', () => {
    // The stored URL encodes a space as %20; URLSearchParams re-serializes
    // it as +. The endpoint did not change — masked headers and the
    // clientSecret must survive the round-trip.
    const previous: McpConfigFile = {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        api: {
          url: 'https://api.example.com/mcp?label=a%20b&api_key=qk-secret-1',
          headers: { Authorization: 'Bearer live-token' },
          oauth: { clientId: 'abc', clientSecret: 'real-secret' },
        },
      },
    };
    const restored = restoreMcpConfigSecrets(redactMcpConfigSecrets(previous), previous);
    const server = restored.mcpServers.api;
    assert.ok(server && 'url' in server);
    assert.deepEqual(server.headers, { Authorization: 'Bearer live-token' });
    assert.equal(server.oauth?.clientSecret, 'real-secret');
    assert.equal(new URL(server.url).searchParams.get('api_key'), 'qk-secret-1');
    assert.equal(new URL(server.url).searchParams.get('label'), 'a b');
  });

  it('masks and restores repeated sensitive query keys per occurrence', () => {
    const previous: McpConfigFile = {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        api: { url: 'https://api.example.com/mcp?token=a1a1&region=eu&token=b2b2' },
      },
    };
    const redacted = redactMcpConfigSecrets(previous);
    const server = redacted.mcpServers.api;
    assert.ok(server && 'url' in server);
    const masked = new URL(server.url);
    // Both occurrences survive, each bound to its own position.
    assert.deepEqual(masked.searchParams.getAll('token'), [
      mcpSecretMarker('query.token.0'),
      mcpSecretMarker('query.token.1'),
    ]);
    assert.equal(masked.searchParams.get('region'), 'eu');

    const restored = restoreMcpConfigSecrets(redacted, previous);
    const restoredServer = restored.mcpServers.api;
    assert.ok(restoredServer && 'url' in restoredServer);
    assert.deepEqual(new URL(restoredServer.url).searchParams.getAll('token'), ['a1a1', 'b2b2']);
  });

  it('rejects a marker moved to a different position', () => {
    const previous: McpConfigFile = {
      version: MCP_CONFIG_VERSION,
      mcpServers: {
        local: { command: 'npx', env: { PGPASSWORD: 'pg-secret', OTHER: 'plain' } },
      },
    };
    const redacted = redactMcpConfigSecrets(previous);
    const server = redacted.mcpServers.local;
    assert.ok(server && 'command' in server);
    // A renderer swaps PGPASSWORD's marker into OTHER: the marker is bound
    // to its position and must not act as a wildcard anywhere else.
    const swapped = structuredClone(redacted);
    const swappedServer = swapped.mcpServers.local;
    assert.ok(swappedServer && 'command' in swappedServer && swappedServer.env);
    swappedServer.env.OTHER = swappedServer.env.PGPASSWORD as string;
    assert.throws(() => restoreMcpConfigSecrets(swapped, previous), McpSecretRestoreError);
  });

  it('replaces a stored clientSecret with the sentinel and leaves the rest', () => {
    const redacted = redactMcpConfigSecrets(withSecret('real-secret'));
    const notion = redacted.mcpServers.notion;
    assert.ok(notion && 'url' in notion);
    assert.equal(notion.oauth?.clientSecret, mcpSecretMarker('oauth'));
    assert.equal(notion.oauth?.clientId, 'abc');
    // stdio server untouched
    assert.ok(redacted.mcpServers.local && 'command' in redacted.mcpServers.local);
  });

  it('restores a sentinel from the previous on-disk value', () => {
    const previous = withSecret('real-secret');
    const incoming = redactMcpConfigSecrets(previous);
    const restored = restoreMcpConfigSecrets(incoming, previous);
    const notion = restored.mcpServers.notion;
    assert.ok(notion && 'url' in notion);
    assert.equal(notion.oauth?.clientSecret, 'real-secret');
  });

  it('rejects a sentinel when the endpoint URL changed', () => {
    const previous = withSecret('real-secret');
    const incoming = redactMcpConfigSecrets(previous);
    const notionIn = incoming.mcpServers.notion;
    assert.ok(notionIn && 'url' in notionIn);
    // A semi-trusted renderer keeps the sentinel but points the id at its
    // own endpoint; main must not forward the unreadable secret there.
    notionIn.url = 'https://attacker.example/mcp';
    assert.throws(() => restoreMcpConfigSecrets(incoming, previous), McpSecretRestoreError);
  });

  it('rejects a sentinel when the clientId changed', () => {
    const previous = withSecret('real-secret');
    const incoming = redactMcpConfigSecrets(previous);
    const notionIn = incoming.mcpServers.notion;
    assert.ok(notionIn && 'url' in notionIn && notionIn.oauth);
    notionIn.oauth.clientId = 'other-client';
    assert.throws(() => restoreMcpConfigSecrets(incoming, previous), McpSecretRestoreError);
  });

  it('rejects a sentinel that has no previous value instead of persisting or dropping it', () => {
    const incoming = withSecret(mcpSecretMarker('oauth'));
    assert.throws(
      () => restoreMcpConfigSecrets(incoming, { version: MCP_CONFIG_VERSION, mcpServers: {} }),
      McpSecretRestoreError,
    );
  });

  it('keeps a genuinely new secret (not the sentinel) on single-server restore', () => {
    const config = withSecret('brand-new');
    const server = config.mcpServers.notion;
    assert.ok(server);
    const restored = restoreMcpServerSecret('notion', server, { version: MCP_CONFIG_VERSION, mcpServers: {} });
    assert.ok('url' in restored);
    assert.equal(restored.oauth?.clientSecret, 'brand-new');
  });
});
