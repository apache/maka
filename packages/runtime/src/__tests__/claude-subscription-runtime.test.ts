import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { PROVIDER_REGISTRY, type LlmConnection } from '@maka/core';
import { testConnection } from '../test-connection.js';

describe('Claude subscription runtime wiring', () => {
  test('testConnection treats resolved Claude OAuth token as a usable login', async () => {
    const result = await testConnection(claudeOAuthConnection(), 'oauth-access-token');
    assert.equal(result.ok, true);
  });

  test('testConnection never burns Claude OAuth quota with a synthetic messages probe', async () => {
    const src = await readFile(new URL('../../src/test-connection.ts', import.meta.url), 'utf8');
    const branchIdx = src.indexOf("connection.providerType === 'claude-subscription'");
    assert.notEqual(branchIdx, -1, 'Claude OAuth test branch must exist');
    const branchRegion = src.slice(
      branchIdx,
      src.indexOf('const r = await proxiedFetch', branchIdx),
    );
    assert.match(
      branchRegion,
      /return \{ ok: true, latencyMs: Date\.now\(\) - t0, modelTested: model \}/,
      'Claude OAuth connection test should validate stored login presence without calling the chat endpoint',
    );
    assert.doesNotMatch(branchRegion, /anthropicV1Url\(baseUrl, '\/messages'\)/);
    assert.doesNotMatch(branchRegion, /messages:\s*\[\{ role: 'user', content: 'Hi' \}\]/);
  });

  test('model factory constructs Anthropic with authToken for claude-subscription', async () => {
    const src = await readFile(new URL('../../src/model-factory.ts', import.meta.url), 'utf8');
    const caseIdx = src.indexOf("case 'claude-subscription'");
    assert.notEqual(caseIdx, -1, 'claude-subscription case must exist');
    const caseRegion = src.slice(caseIdx, src.indexOf("case 'openai-codex'", caseIdx));
    assert.match(
      caseRegion,
      /createAnthropic\(\{[\s\S]*authToken:\s*apiKey/,
      'Claude OAuth must use AI SDK Anthropic authToken',
    );
    assert.match(
      caseRegion,
      /baseURL:\s*anthropicV1BaseUrl\(baseURL\)/,
      'Claude OAuth must pass the AI SDK a /v1 Anthropic base URL',
    );
    assert.match(caseRegion, /fetch,/, 'Claude OAuth must accept the desktop cloak fetch wrapper');
    assert.doesNotMatch(
      caseRegion,
      /throw new Error/,
      'Claude OAuth must not remain in the experimental throw branch',
    );
    assert.match(
      caseRegion,
      /headers:\s*claudeSubscriptionHeaders\(\)/,
      'Claude OAuth must use the centralized Claude Code subscription header helper',
    );
    assert.match(
      caseRegion,
      /claudeSubscriptionHeaders/,
      'Claude OAuth runtime sends must use the pinned Claude Code user-agent',
    );
  });

  test('Claude subscription header constants have one runtime source of truth', async () => {
    const [authSrc, factorySrc, fetcherSrc, testConnectionSrc] = await Promise.all([
      readFile(new URL('../../src/subscription-auth.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/model-factory.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/model-fetcher.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../src/test-connection.ts', import.meta.url), 'utf8'),
    ]);

    assert.match(
      authSrc,
      /CLAUDE_SUBSCRIPTION_USER_AGENT\s*=\s*'claude-cli\/2\.1\.153 \(external, cli\)'/,
      'Claude OAuth runtime user-agent must track the current installed Claude Code OAuth contract',
    );
    assert.match(authSrc, /CLAUDE_SUBSCRIPTION_BETA[\s\S]*oauth-2025-04-20/);
    assert.match(authSrc, /function claudeSubscriptionHeaders\(\)/);

    for (const [name, source] of [
      ['model-factory.ts', factorySrc],
      ['model-fetcher.ts', fetcherSrc],
      ['test-connection.ts', testConnectionSrc],
    ] as const) {
      assert.match(
        source,
        /claudeSubscriptionHeaders/,
        `${name} must use the centralized Claude subscription headers helper`,
      );
      assert.doesNotMatch(
        source,
        /claude-cli\/2\.1\.153|oauth-2025-04-20/,
        `${name} must not duplicate Claude subscription header literals`,
      );
      assert.doesNotMatch(
        source,
        /const CLAUDE_SUBSCRIPTION_(?:BETA|USER_AGENT)/,
        `${name} must not redeclare Claude subscription header constants`,
      );
    }
  });

  test('anthropicV1BaseUrl normalizes base URLs to a single /v1 suffix', async () => {
    const { anthropicV1BaseUrl } = await import('../provider-urls.js');
    assert.equal(
      anthropicV1BaseUrl('https://api.anthropic.com'),
      'https://api.anthropic.com/v1',
      'bare root gains /v1',
    );
    assert.equal(
      anthropicV1BaseUrl('https://api.anthropic.com/'),
      'https://api.anthropic.com/v1',
      'trailing slash is stripped before re-appending /v1',
    );
    assert.equal(
      anthropicV1BaseUrl('https://api.anthropic.com/v1'),
      'https://api.anthropic.com/v1',
      'already-versioned root is idempotent',
    );
    assert.equal(
      anthropicV1BaseUrl('https://api.kimi.com/coding/v1'),
      'https://api.kimi.com/coding/v1',
      'already-versioned override is idempotent',
    );
    assert.equal(
      anthropicV1BaseUrl('https://api.kimi.com/coding/'),
      'https://api.kimi.com/coding/v1',
      'override omitting /v1 gets it filled in',
    );
  });

  test('registry routes Anthropic and Kimi through the normalized API-key adapter', async () => {
    assert.deepEqual(PROVIDER_REGISTRY.anthropic.runtimeAdapter, {
      kind: 'anthropic',
      auth: 'api-key',
      normalizeBaseUrl: true,
    });
    assert.deepEqual(PROVIDER_REGISTRY['kimi-coding-plan'].runtimeAdapter, {
      kind: 'anthropic',
      auth: 'api-key',
      normalizeBaseUrl: true,
    });
    const src = await readFile(new URL('../../src/model-factory.ts', import.meta.url), 'utf8');
    const region = src.slice(
      src.indexOf("case 'anthropic'"),
      src.indexOf("case 'claude-subscription'"),
    );
    assert.match(region, /adapter\.normalizeBaseUrl\s*\?\s*anthropicV1BaseUrl\(baseURL\)/);
    assert.match(
      region,
      /fetch,/,
      'Anthropic-compatible providers must accept an explicitly supplied proxy transport',
    );
  });

  test('registry sends both MiniMax variants over Bearer without rewriting their base URL', () => {
    const expected = { kind: 'anthropic', auth: 'bearer', normalizeBaseUrl: false };
    assert.deepEqual(PROVIDER_REGISTRY.MiniMax.runtimeAdapter, expected);
    assert.deepEqual(PROVIDER_REGISTRY['MiniMax-cn'].runtimeAdapter, expected);
  });

  test('model factory wires openai-codex to OpenAI Responses with account-scoped fetch/header shape', async () => {
    const src = await readFile(new URL('../../src/model-factory.ts', import.meta.url), 'utf8');
    assert.deepEqual(PROVIDER_REGISTRY['openai-codex'].runtimeAdapter, { kind: 'openai-codex' });
    const caseIdx = src.indexOf("case 'openai-codex'");
    assert.notEqual(caseIdx, -1, 'openai-codex case must exist');
    const caseRegion = src.slice(caseIdx, src.indexOf("case 'unavailable'", caseIdx));
    assert.match(
      caseRegion,
      /createOpenAI\(\{[\s\S]*apiKey/,
      'Codex OAuth must use OpenAI client with OAuth token',
    );
    assert.match(
      caseRegion,
      /fetch,/,
      'Codex OAuth must accept the desktop ChatGPT backend fetch wrapper',
    );
    assert.match(
      caseRegion,
      /openAiCodexHeaders\(apiKey\)/,
      'Codex OAuth must attach account-scoped headers',
    );
    assert.match(caseRegion, /\.responses\(modelId\)/, 'Codex OAuth must use Responses API');
    assert.doesNotMatch(
      caseRegion,
      /throw new Error/,
      'Codex OAuth must not remain in the experimental throw branch',
    );
  });

  test('testConnection treats resolved Codex OAuth token as a usable login', async () => {
    const result = await testConnection(codexOAuthConnection(), codexAccessToken('acct_test'));
    assert.equal(result.ok, true);
    assert.equal(result.modelTested, 'gpt-5.5');
  });

  test('Codex OAuth headers include ChatGPT Responses beta and account id', async () => {
    const src = await readFile(new URL('../../src/subscription-auth.ts', import.meta.url), 'utf8');
    assert.match(
      src,
      /OpenAI-Beta['"]:\s*['"]responses=experimental/,
      'Codex OAuth must opt into ChatGPT Responses beta',
    );
    assert.equal(
      (await import('../subscription-auth.js')).openAiCodexHeaders(codexAccessToken('acct_test'))[
        'ChatGPT-Account-Id'
      ],
      'acct_test',
    );
  });

  test('Codex OAuth headers do not fall back to JWT sub as ChatGPT account id', async () => {
    const { openAiCodexHeaders } = await import('../subscription-auth.js');
    const headers = openAiCodexHeaders(codexAccessTokenWithoutChatGptAccount('sub_not_account'));
    assert.equal(headers['ChatGPT-Account-Id'], undefined);
  });

  test('Codex OAuth provider options use non-persistent ChatGPT backend defaults', async () => {
    const src = await readFile(new URL('../../src/model-factory.ts', import.meta.url), 'utf8');
    const fnIdx = src.indexOf('export function buildProviderOptions');
    const caseIdx = src.indexOf("case 'openai-codex'", fnIdx);
    const caseRegion = src.slice(caseIdx, src.indexOf("case 'openai'", caseIdx));
    assert.match(
      caseRegion,
      /store:\s*false/,
      'Codex OAuth sends must not persist Responses API inputs by default',
    );
    assert.match(
      caseRegion,
      /textVerbosity:\s*['"]medium['"]/,
      'Codex OAuth sends must use the ChatGPT backend text verbosity shape',
    );
  });
});

function claudeOAuthConnection(): LlmConnection {
  return {
    slug: 'claude-subscription',
    name: 'Claude OAuth',
    providerType: 'claude-subscription',
    defaultModel: 'claude-sonnet-4-5-20250929',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function codexOAuthConnection(): LlmConnection {
  return {
    slug: 'openai-codex',
    name: 'Codex OAuth',
    providerType: 'openai-codex',
    defaultModel: 'gpt-5.5',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function codexAccessToken(accountId: string): string {
  return [
    base64url({ alg: 'none', typ: 'JWT' }),
    base64url({
      sub: 'sub_fallback',
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
      },
    }),
    'signature',
  ].join('.');
}

function codexAccessTokenWithoutChatGptAccount(sub: string): string {
  return [base64url({ alg: 'none', typ: 'JWT' }), base64url({ sub }), 'signature'].join('.');
}

function base64url(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
