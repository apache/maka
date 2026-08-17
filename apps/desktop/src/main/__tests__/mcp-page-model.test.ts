import assert from 'node:assert/strict';
import test from 'node:test';
import { isMcpStdioConfig, type McpServerStatus } from '@maka/core/mcp';
import { MCP_CATALOG } from '../../renderer/mcp-catalog.js';
import { getMcpCopy } from '../../renderer/locales/mcp-copy.js';
import {
  createEmptyMcpDraft,
  mcpConfigFromDraft,
  mcpDraftFromConfig,
  presentMcpNegotiatedProtocol,
  withMcpDraftTransport,
} from '../../renderer/mcp-page-model.js';

const copy = getMcpCopy('en');

test('a newly-authored remote MCP persists an explicit auto preference', () => {
  const config = mcpConfigFromDraft(
    {
      ...createEmptyMcpDraft(),
      id: 'remote',
      kind: 'remote',
      url: ' https://example.com/mcp ',
    },
    copy,
  );

  assert.deepEqual(config, {
    enabled: true,
    url: 'https://example.com/mcp',
    transport: 'auto',
    protocol: 'auto',
    headers: {},
  });
});

test('editing an omitted remote preference presents and preserves legacy semantics', () => {
  const draft = mcpDraftFromConfig('existing', {
    url: 'https://example.com/mcp',
    transport: 'streamable-http',
  });

  assert.equal(draft.protocol, 'legacy');
  assert.deepEqual(mcpConfigFromDraft(draft, copy), {
    enabled: true,
    url: 'https://example.com/mcp',
    transport: 'streamable-http',
    protocol: 'legacy',
    headers: {},
  });
});

test('editing a remote MCP round-trips auto and exact modern preferences', () => {
  for (const protocol of ['auto', '2026-07-28'] as const) {
    const draft = mcpDraftFromConfig('remote', {
      url: 'https://example.com/mcp',
      transport: 'streamable-http',
      protocol,
    });

    const saved = mcpConfigFromDraft(draft, copy);
    assert.equal(!isMcpStdioConfig(saved) && saved.protocol, protocol);
  }
});

test('selecting legacy SSE converges and persists the legacy preference', () => {
  const modern = {
    ...createEmptyMcpDraft(),
    kind: 'remote' as const,
    url: 'https://example.com/sse',
    protocol: '2026-07-28' as const,
  };
  const sse = withMcpDraftTransport(modern, 'sse');

  assert.equal(sse.protocol, 'legacy');
  assert.deepEqual(mcpConfigFromDraft(sse, copy), {
    enabled: true,
    url: 'https://example.com/sse',
    transport: 'sse',
    protocol: 'legacy',
    headers: {},
  });

  // The serializer also protects against an inconsistent draft supplied by a
  // stale renderer event.
  const forged = mcpConfigFromDraft({ ...sse, protocol: 'auto' }, copy);
  assert.equal(!isMcpStdioConfig(forged) && forged.protocol, 'legacy');
});

test('stdio editing never adds a protocol preference in config version 2', () => {
  const saved = mcpConfigFromDraft(
    { ...createEmptyMcpDraft(), id: 'local', commandLine: ' node ' },
    copy,
  );

  assert.equal(isMcpStdioConfig(saved), true);
  assert.equal(Object.hasOwn(saved, 'protocol'), false);
});

test('the MCP catalog opts every bundled remote entry into auto negotiation', () => {
  const remoteEntries = MCP_CATALOG.filter((entry) => !isMcpStdioConfig(entry.config));

  assert.deepEqual(
    remoteEntries.map((entry) => entry.id),
    ['notion', 'vercel', 'supabase'],
  );
  for (const entry of remoteEntries) {
    assert.equal(!isMcpStdioConfig(entry.config) && entry.config.protocol, 'auto');
  }
});

test('status copy presents only a live connected negotiated protocol', () => {
  const status: McpServerStatus = {
    serverId: 'remote',
    state: 'connected',
    transport: 'streamable-http',
    negotiatedProtocol: { era: 'modern', revision: '2026-07-28' },
    toolCount: 0,
    tools: [],
    updatedAt: 1,
  };

  assert.equal(
    presentMcpNegotiatedProtocol(status, copy),
    'Modern · 2026-07-28',
  );
  assert.equal(
    presentMcpNegotiatedProtocol({ ...status, state: 'disconnected' }, copy),
    undefined,
  );
});
