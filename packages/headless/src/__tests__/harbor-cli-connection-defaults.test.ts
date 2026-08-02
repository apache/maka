import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test, afterEach } from 'node:test';
import { resolveEconomyTaskMode } from '../economy-task-policy.js';
import { resolveHarborCellAiSdkEnv } from '../harbor-cell.js';
import { applyConnectionDefaults, resolveHarborRunOptions } from '../harbor-cli.js';
import { validateRealBackendIsolation } from '../isolation.js';

/**
 * Tests for applyConnectionDefaults — the function that reads
 * llm-connections.json and injects MAKA_MODEL, MAKA_LLM_CONNECTION_SLUG,
 * and MAKA_BASE_URL into the env when no explicit model is set.
 */

let cleanupDirs: string[] = [];

function makeTempConnections(content: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'maka-conn-test-'));
  cleanupDirs.push(dir);
  const filePath = join(dir, 'llm-connections.json');
  writeFileSync(filePath, JSON.stringify(content), 'utf8');
  return filePath;
}

afterEach(() => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  cleanupDirs = [];
});

describe('applyConnectionDefaults', () => {
  const defaultDocument = (connection: Record<string, unknown> = {}) => ({
    defaultSlug: 'harbor-anthropic',
    connections: [
      {
        slug: 'harbor-anthropic',
        providerType: 'anthropic',
        defaultModel: 'claude-sonnet-4-20250514',
        baseUrl: 'http://127.0.0.1:8537',
        enabled: true,
        ...connection,
      },
    ],
  });

  test('injects the complete default connection and colocated credentials path', () => {
    const connectionsPath = makeTempConnections(defaultDocument());
    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };

    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, 'anthropic/claude-sonnet-4-20250514');
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, 'harbor-anthropic');
    assert.equal(env.MAKA_BASE_URL, 'http://127.0.0.1:8537');
    assert.equal(env.MAKA_CREDENTIALS_PATH, join(dirname(connectionsPath), 'credentials.json'));
  });

  test('does not override explicit model, provider, or connection authority', () => {
    const connectionsPath = makeTempConnections(defaultDocument());

    for (const [name, value] of [
      ['MAKA_MODEL', 'deepseek/deepseek-v4-flash'],
      ['HARBOR_MODEL', 'some-model'],
      ['MAKA_PROVIDER', 'deepseek'],
      ['MAKA_LLM_CONNECTION_SLUG', 'my-custom-slug'],
    ] as const) {
      const env: Record<string, string | undefined> = {
        MAKA_CONNECTIONS_PATH: connectionsPath,
        [name]: value,
      };
      const before = { ...env };

      applyConnectionDefaults(env);

      assert.deepEqual(env, before, name);
    }
  });

  test('ignores missing, malformed, disabled, incomplete, or unsupported connection sources', () => {
    const malformedDir = mkdtempSync(join(tmpdir(), 'maka-conn-test-'));
    cleanupDirs.push(malformedDir);
    const malformedPath = join(malformedDir, 'llm-connections.json');
    writeFileSync(malformedPath, '{ not valid json!!!', 'utf8');

    const sources = [
      '/tmp/nonexistent-path-abc123/llm-connections.json',
      malformedPath,
      makeTempConnections(defaultDocument({ enabled: false })),
      makeTempConnections({
        connections: [
          {
            slug: 'some-conn',
            providerType: 'anthropic',
            defaultModel: 'claude-sonnet-4',
            enabled: true,
          },
        ],
      }),
      makeTempConnections({
        defaultSlug: 'missing-slug',
        connections: [
          {
            slug: 'other-conn',
            providerType: 'anthropic',
            defaultModel: 'claude-sonnet-4',
            enabled: true,
          },
        ],
      }),
      makeTempConnections(defaultDocument({ providerType: 'totally-unknown-provider' })),
    ];

    for (const connectionsPath of sources) {
      const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };

      applyConnectionDefaults(env);

      assert.deepEqual(env, { MAKA_CONNECTIONS_PATH: connectionsPath }, connectionsPath);
    }
  });

  test('leaves MAKA_BASE_URL unset when the connection has no base URL', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'deepseek-default',
      connections: [
        {
          slug: 'deepseek-default',
          providerType: 'deepseek',
          defaultModel: 'deepseek-v4-flash',
          enabled: true,
        },
      ],
    });
    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };

    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, 'deepseek/deepseek-v4-flash');
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, 'deepseek-default');
    assert.equal(env.MAKA_BASE_URL, undefined);
  });

  test('preserves an explicit base URL while filling the remaining defaults', () => {
    const connectionsPath = makeTempConnections(defaultDocument());
    const env: Record<string, string | undefined> = {
      MAKA_CONNECTIONS_PATH: connectionsPath,
      MAKA_BASE_URL: 'http://custom-url:9999',
    };

    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, 'anthropic/claude-sonnet-4-20250514');
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, 'harbor-anthropic');
    assert.equal(env.MAKA_BASE_URL, 'http://custom-url:9999');
  });

  test('skips defaults for fake and pi-agent backends', () => {
    const connectionsPath = makeTempConnections(defaultDocument());

    for (const backend of ['fake', 'pi-agent']) {
      const env: Record<string, string | undefined> = {
        MAKA_CONNECTIONS_PATH: connectionsPath,
        MAKA_BACKEND: backend,
      };
      const before = { ...env };

      applyConnectionDefaults(env);

      assert.deepEqual(env, before, backend);
    }
  });

  test('normalizes the legacy codex-subscription provider type', () => {
    const connectionsPath = makeTempConnections({
      defaultSlug: 'codex-subscription',
      connections: [
        {
          slug: 'codex-subscription',
          providerType: 'codex-subscription',
          defaultModel: 'gpt-5.6-sol',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          enabled: true,
        },
      ],
    });
    const env: Record<string, string | undefined> = { MAKA_CONNECTIONS_PATH: connectionsPath };

    applyConnectionDefaults(env);

    assert.equal(env.MAKA_MODEL, 'openai-codex/gpt-5.6-sol');
    assert.equal(env.MAKA_LLM_CONNECTION_SLUG, 'codex-subscription');
    assert.equal(env.MAKA_BASE_URL, 'https://chatgpt.com/backend-api/codex');
  });
});
describe('resolveHarborRunOptions backend guard', () => {
  test('uses one boolean vocabulary for the Agent tool switch', async () => {
    const defaultOptions = await resolveHarborRunOptions(
      ['--backend', 'fake', '--instruction', 'test'],
      {},
    );
    const enabledOptions = await resolveHarborRunOptions(
      ['--backend', 'fake', '--instruction', 'test'],
      { MAKA_AGENT_TOOLS: 'true' },
    );

    assert.equal(defaultOptions.config.agentTools, false);
    assert.equal(enabledOptions.config.agentTools, true);
    await assert.rejects(
      resolveHarborRunOptions(['--backend', 'fake', '--instruction', 'test'], {
        MAKA_AGENT_TOOLS: 'sometimes',
      }),
      /MAKA_AGENT_TOOLS must be a boolean/,
    );
  });

  test('preserves an explicit economy-task disable over instruction signals', async () => {
    const opts = await resolveHarborRunOptions(
      ['--backend', 'fake', '--instruction', 'summarize the log files'],
      { MAKA_ECONOMY_TASK_MODE: 'false' },
    );

    const selection = resolveEconomyTaskMode(opts.config, {
      id: 'economy-signal-task',
      instruction: opts.instruction,
      workspaceDir: '/workspace',
      verification: { command: 'true', protectedPaths: [] },
    });

    assert.equal(selection.enabled, false);
    assert.equal(selection.triggerSource, 'config');
  });

  test('wires an explicit environment-proxy fetch into real container backends', async () => {
    const opts = await resolveHarborRunOptions(
      ['--instruction', 'test', '--isolation', 'harbor-local'],
      {
        MAKA_MODEL: 'openai-codex/gpt-5.6-sol',
        MAKA_HOST_API_KEY: 'selected-host-token',
        MAKA_HOST_BASE_URL: 'http://host.docker.internal:443',
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: 'http://agent:test@pier-egress-proxy:8080',
        HTTPS_PROXY: 'http://agent:test@pier-egress-proxy:8080',
        NO_PROXY: 'localhost,127.0.0.1',
      },
    );

    try {
      assert.ok(opts.providerEnvFetch);
      assert.ok(opts.registerBackends);
    } finally {
      await opts.providerEnvFetch?.close();
    }
  });

  test('keeps a local external workspace separate from the headless source fixture', async () => {
    const opts = await resolveHarborRunOptions(
      [
        '--backend',
        'fake',
        '--instruction',
        'test',
        '--isolation',
        'harbor-local',
        '--workdir',
        '/app',
        '--out',
        '/logs/agent/maka-task-run',
      ],
      {},
    );

    assert.equal(opts.workdir, '/app');
    assert.equal(opts.sourceWorkspaceDir, '/logs/agent/maka-task-run/host-workspace-source');
    assert.equal(
      opts.realBackendIsolation?.submittedSnapshotRoot,
      '/logs/agent/maka-task-run/submitted-snapshots',
    );
  });

  test('rejects a persistent snapshot root inside its source workspace', async () => {
    const opts = await resolveHarborRunOptions(
      [
        '--backend',
        'fake',
        '--instruction',
        'test',
        '--isolation',
        'harbor-local',
        '--workdir',
        '/workspace',
        '--out',
        '/workspace/out',
      ],
      {},
    );

    assert.throws(
      () => validateRealBackendIsolation(opts.realBackendIsolation),
      /submittedSnapshotRoot must stay outside workspaceDir/,
    );
    assert.doesNotThrow(() =>
      validateRealBackendIsolation({
        kind: 'external',
        label: 'Pier task container',
        workspaceDir: '/app',
        submittedSnapshotRoot: '/logs/agent/submitted-snapshots',
      }),
    );
  });

  test('uses the strict cell soft-timeout parser in task-run mode', async () => {
    await assert.rejects(
      resolveHarborRunOptions(['--backend', 'fake', '--instruction', 'test'], {
        MAKA_CELL_SOFT_TIMEOUT_MS: '1e3',
      }),
      /MAKA_CELL_SOFT_TIMEOUT_MS must be a positive integer/,
    );
  });

  test('task-run preserves the adapter absolute model deadline', async () => {
    const opts = await resolveHarborRunOptions(
      ['--mode', 'task-run', '--backend', 'fake', '--instruction', 'test'],
      {
        MAKA_CELL_DEADLINE_AT_MS: '2800000',
      },
    );

    assert.equal(opts.deadlineAtMs, 2_800_000);
  });

  test('explicit host authority overrides stale ambient provider authority', async () => {
    const opts = await resolveHarborRunOptions(
      ['--instruction', 'test', '--isolation', 'harbor-local'],
      {
        MAKA_MODEL: 'openai-codex/gpt-5.6-codex',
        MAKA_HOST_API_KEY: 'selected-host-token',
        MAKA_HOST_BASE_URL: 'http://127.0.0.1:43210/v1',
        MAKA_HOST_MODEL_API_PROTOCOL: 'openai-responses',
        OPENAI_CODEX_OAUTH_TOKEN: 'stale-ambient-token',
        MAKA_BASE_URL: 'https://stale.example/v1',
        MAKA_MODEL_API_PROTOCOL: 'openai-chat',
      },
    );

    const resolved = resolveHarborCellAiSdkEnv({
      provider: 'openai-codex',
      model: 'gpt-5.6-codex',
      env: opts.env,
      ts: 1,
    });
    assert.equal(resolved.apiKey, 'selected-host-token');
    assert.equal(resolved.connection.baseUrl, 'http://127.0.0.1:43210/v1');
  });

  test('file-based host authority overrides stale ambient provider credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maka-host-authority-'));
    cleanupDirs.push(dir);
    const keyFile = join(dir, 'deepseek-key');
    writeFileSync(keyFile, 'selected-file-token\n', 'utf8');

    const opts = await resolveHarborRunOptions(
      ['--instruction', 'test', '--isolation', 'harbor-local'],
      {
        MAKA_MODEL: 'deepseek/deepseek-chat',
        MAKA_HOST_API_KEY_FILE: keyFile,
        DEEPSEEK_API_KEY: 'stale-deepseek-token',
        OPENAI_API_KEY: 'stale-fallback-token',
      },
    );

    const resolved = resolveHarborCellAiSdkEnv({
      provider: 'deepseek',
      model: 'deepseek-chat',
      env: opts.env,
      ts: 1,
    });
    assert.equal(resolved.apiKey, 'selected-file-token');
  });

  test('explicit host authority bypasses higher-priority ambient credential aliases', async () => {
    const opts = await resolveHarborRunOptions(
      ['--instruction', 'test', '--isolation', 'harbor-local'],
      {
        MAKA_MODEL: 'deepseek/deepseek-chat',
        MAKA_HOST_API_KEY: 'selected-host-token',
        DEEPSEEK_API_KEY: 'stale-primary-token',
      },
    );
    const resolved = resolveHarborCellAiSdkEnv({
      provider: 'deepseek',
      model: 'deepseek-chat',
      env: opts.env,
      ts: 1,
    });

    assert.equal(resolved.apiKey, 'selected-host-token');
  });

  test('explicit no-auth authority bypasses ambient and stored provider credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maka-host-no-auth-'));
    cleanupDirs.push(dir);
    const credentialsPath = join(dir, 'credentials.json');
    writeFileSync(
      credentialsPath,
      JSON.stringify({ version: 1, values: { 'localai:apiKey': 'stored-token' } }),
      'utf8',
    );
    const opts = await resolveHarborRunOptions(
      ['--instruction', 'test', '--isolation', 'harbor-local'],
      {
        MAKA_MODEL: 'localai/local-model',
        MAKA_HOST_NO_AUTH: 'true',
        MAKA_HOST_BASE_URL: 'http://127.0.0.1:8080/v1',
        MAKA_CREDENTIALS_PATH: credentialsPath,
        LOCALAI_API_KEY: 'ambient-token',
      },
    );
    const resolved = resolveHarborCellAiSdkEnv({
      provider: 'localai',
      model: 'local-model',
      env: opts.env,
      ts: 1,
    });

    assert.equal(resolved.apiKey, '');
    assert.equal(resolved.connection.baseUrl, 'http://127.0.0.1:8080/v1');
  });

  test('--backend fake flag skips applyConnectionDefaults (no desktop connection pollution)', async () => {
    // cliEnv does not forward the --backend flag into env.MAKA_BACKEND, so the
    // in-function guard inside applyConnectionDefaults only covers the
    // MAKA_BACKEND env-var path. resolveHarborRunOptions must resolve backend
    // first and skip applyConnectionDefaults for non-ai-sdk backends.
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });
    const opts = await resolveHarborRunOptions(['--backend', 'fake', '--instruction', 'test'], {
      MAKA_CONNECTIONS_PATH: connectionsPath,
    });
    assert.equal(opts.backend, 'fake');
    assert.equal(
      opts.env.MAKA_MODEL,
      undefined,
      'desktop default connection must not pollute fake backend',
    );
    assert.equal(opts.env.MAKA_LLM_CONNECTION_SLUG, undefined);
  });

  test('--api-key-file infers provider from the default connection (anthropic, not deepseek)', async () => {
    // applyApiKeyFile runs after applyConnectionDefaults, so its provider
    // inference must use the resolved MAKA_MODEL (anthropic), not a hardcoded
    // default. Without the ordering, --api-key-file would write
    // DEEPSEEK_API_KEY_FILE for an anthropic default connection.
    const connectionsPath = makeTempConnections({
      defaultSlug: 'harbor-anthropic',
      connections: [
        {
          slug: 'harbor-anthropic',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-20250514',
          baseUrl: 'http://127.0.0.1:8537',
          enabled: true,
        },
      ],
    });
    const opts = await resolveHarborRunOptions(
      ['--instruction', 'test', '--api-key-file', '/tmp/key', '--isolation', 'harbor-local'],
      { MAKA_CONNECTIONS_PATH: connectionsPath },
    );
    assert.equal(opts.env.ANTHROPIC_API_KEY_FILE, '/tmp/key');
    assert.equal(opts.env.DEEPSEEK_API_KEY_FILE, undefined);
  });

  test('--api-key-file uses the SiliconFlow credential file env', async () => {
    const opts = await resolveHarborRunOptions(
      [
        '--provider',
        'siliconflow',
        '--model',
        'moonshotai/Kimi-K2.6',
        '--instruction',
        'test',
        '--api-key-file',
        '/tmp/siliconflow-key',
        '--isolation',
        'harbor-local',
      ],
      {},
    );

    assert.equal(opts.env.SILICONFLOW_API_KEY_FILE, '/tmp/siliconflow-key');
    assert.equal(opts.env.OPENAI_API_KEY_FILE, undefined);
  });

  test('--api-key-file uses the Vercel Gateway namespace without consuming the creator/model prefix', async () => {
    const opts = await resolveHarborRunOptions(
      [
        '--provider',
        'vercel',
        '--model',
        'xai/grok-4.3',
        '--instruction',
        'test',
        '--api-key-file',
        '/tmp/vercel-key',
        '--isolation',
        'harbor-local',
      ],
      {},
    );

    assert.equal(opts.config.model, 'xai/grok-4.3');
    assert.equal(opts.env.MAKA_PROVIDER, 'vercel');
    assert.equal(opts.env.AI_GATEWAY_API_KEY_FILE, '/tmp/vercel-key');
    assert.equal(opts.env.OPENAI_API_KEY_FILE, undefined);
  });
});
