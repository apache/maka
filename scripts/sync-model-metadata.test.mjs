import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
