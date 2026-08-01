import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const PROVIDER_IDS = [
  'alibaba',
  'alibaba-coding-plan',
  'alibaba-coding-plan-cn',
  'alibaba-token-plan',
  'alibaba-token-plan-cn',
  'anthropic',
  'cerebras',
  'cloudflare-workers-ai',
  'cohere',
  'deepinfra',
  'deepseek',
  'fireworks-ai',
  'github-copilot',
  'google',
  'groq',
  'huggingface',
  'minimax',
  'minimax-cn',
  'mistral',
  'moonshotai-cn',
  'nvidia',
  'ollama-cloud',
  'openai',
  'opencode',
  'opencode-go',
  'openrouter',
  'siliconflow',
  'stepfun',
  'stepfun-ai',
  'stepfun-ai-step-plan',
  'tencent-coding-plan',
  'tencent-token-plan',
  'tencent-tokenhub',
  'togetherai',
  'vercel',
  'xai',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai',
  'zai-coding-plan',
  'zenmux',
];

function withRequiredProviders(openai = {}) {
  return Object.fromEntries(
    PROVIDER_IDS.map((id) => [
      id,
      {
        id,
        name: id,
        api: `https://api.example.com/${id}`,
        doc: 'https://example.com/models',
        models: {
          model: {
            name: 'Model',
            reasoning: false,
            tool_call: false,
            limit: { context: 1, output: 1 },
          },
        },
        ...(id === 'openai' ? openai : {}),
      },
    ]),
  );
}

async function generate(catalog) {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  try {
    await writeFile(input, JSON.stringify(catalog));
    await execFileAsync(process.execPath, [
      'scripts/sync-model-metadata.mjs',
      '--input',
      input,
      '--output',
      output,
    ]);
    return await readFile(output, 'utf8');
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test('sync-model-metadata maps capabilities and lifecycle from models.dev', async () => {
  const generated = await generate(
    withRequiredProviders({
      models: {
        vision: {
          name: 'Vision Model',
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 128_000, output: 16_000 },
        },
        deprecated: {
          name: 'Deprecated Model',
          reasoning: false,
          tool_call: false,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 32_000, output: 4_000 },
          status: 'deprecated',
        },
      },
    }),
  );

  assert.match(generated, /"vision":true,"reasoning":true,"functionCalling":true/);
  assert.match(generated, /"modalities":\{"input":\["text","image"\],"output":\["text"\]\}/);
  assert.match(generated, /"deprecated".*"lifecycle":"deprecated".*"vision":false/);
  assert.match(generated, /export const GENERATED_MODELS_DEV_PROVIDER_FACTS/);
});

test('sync-model-metadata preserves provider ids and per-model protocol overrides', async () => {
  const catalog = withRequiredProviders();
  catalog.opencode = {
    ...catalog.opencode,
    name: 'OpenCode Zen',
    api: 'https://opencode.ai/zen/v1',
    models: {
      'gpt-5.5': {
        name: 'GPT 5.5',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 400_000, output: 128_000 },
        provider: {
          npm: '@ai-sdk/openai',
          api: 'https://opencode.ai/zen/v1/responses-compatible',
        },
      },
    },
  };

  const generated = await generate(catalog);

  assert.match(
    generated,
    /"opencode": \{"id":"opencode","name":"OpenCode Zen","api":"https:\/\/opencode\.ai\/zen\/v1"/,
  );
  assert.match(
    generated,
    /"opencode": \{"gpt-5\.5":\{"npm":"@ai-sdk\/openai","api":"https:\/\/opencode\.ai\/zen\/v1\/responses-compatible"\}\}/,
  );
});

test('sync-model-metadata fails closed on malformed or incomplete upstream data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-invalid-'));
  const input = join(directory, 'api.json');
  try {
    await writeFile(
      input,
      JSON.stringify(withRequiredProviders({ models: { broken: { name: 'Broken' } } })),
    );
    await assert.rejects(
      execFileAsync(process.execPath, ['scripts/sync-model-metadata.mjs', '--input', input]),
      /unsupported shape/,
    );

    await writeFile(
      input,
      JSON.stringify({
        openai: { id: 'openai', name: 'OpenAI', doc: 'https://example.com', models: {} },
      }),
    );
    await assert.rejects(
      execFileAsync(process.execPath, ['scripts/sync-model-metadata.mjs', '--input', input]),
      /provider anthropic is missing/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('sync-model-metadata rejects an option without a value', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/sync-model-metadata.mjs', '--output']),
    /--output requires a value/,
  );
});
