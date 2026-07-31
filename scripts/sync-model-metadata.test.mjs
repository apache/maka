import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

function withRequiredProviders(openai) {
  return Object.fromEntries(
    PROVIDER_IDS.map((id) => {
      const fallback = {
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
      };
      return [id, id === 'openai' ? { ...fallback, ...openai } : fallback];
    }),
  );
}

test('sync-model-metadata maps models.dev modalities into Maka metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  await writeFile(
    input,
    JSON.stringify(
      withRequiredProviders({
        doc: 'https://example.com/models',
        models: {
          'vision-model': {
            id: 'vision-model',
            name: 'Vision Model',
            reasoning: true,
            tool_call: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 128_000, output: 16_000 },
          },
          'text-model': {
            id: 'text-model',
            name: 'Text Model',
            reasoning: false,
            tool_call: false,
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 32_000, output: 4_000 },
            status: 'deprecated',
          },
          'unknown-modality-model': {
            id: 'unknown-modality-model',
            name: 'Unknown Modality Model',
            reasoning: false,
            tool_call: false,
            limit: { context: 32_000, output: 4_000 },
          },
        },
      }),
    ),
  );

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"vision":true,"reasoning":true,"functionCalling":true/);
  assert.match(generated, /"modalities":\{"input":\["text","image"\],"output":\["text"\]\}/);
  assert.match(generated, /"text-model".*"lifecycle":"deprecated".*"vision":false/);
  assert.match(
    generated,
    /"unknown-modality-model".*"capabilities":\{"reasoning":false,"functionCalling":false\}/,
  );
  assert.match(generated, /export const GENERATED_MODELS_DEV_METADATA/);
  assert.match(generated, /export const GENERATED_MODELS_DEV_PROVIDER_FACTS/);
});

test('sync-model-metadata preserves OpenCode provider ids and per-model protocol overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog.opencode = {
    ...catalog.opencode,
    name: 'OpenCode Zen',
    api: 'https://opencode.ai/zen/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT 5.5',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 400_000, output: 128_000 },
        provider: { npm: '@ai-sdk/openai', api: 'https://opencode.ai/zen/v1/responses-compatible' },
      },
    },
  };
  catalog['opencode-go'] = {
    ...catalog['opencode-go'],
    name: 'OpenCode Go',
    api: 'https://opencode.ai/zen/go/v1',
    npm: '@ai-sdk/openai-compatible',
    models: {
      'minimax-m3': {
        id: 'minimax-m3',
        name: 'MiniMax M3',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 204_800, output: 131_072 },
        provider: { npm: '@ai-sdk/anthropic' },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(
    generated,
    /"opencode": \{"id":"opencode","name":"OpenCode Zen","api":"https:\/\/opencode\.ai\/zen\/v1"/,
  );
  assert.match(
    generated,
    /"opencode-go": \{"id":"opencode-go","name":"OpenCode Go","api":"https:\/\/opencode\.ai\/zen\/go\/v1"/,
  );
  assert.match(
    generated,
    /"opencode": \{"gpt-5\.5":\{"npm":"@ai-sdk\/openai","api":"https:\/\/opencode\.ai\/zen\/v1\/responses-compatible"\}\}/,
  );
  assert.match(generated, /"opencode-go": \{"minimax-m3":\{"npm":"@ai-sdk\/anthropic"\}\}/);
});

test('sync-model-metadata vendors the three Xiaomi Token Plan regions and exact MiMo model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  const regions = {
    'xiaomi-token-plan-cn': { name: 'Xiaomi Token Plan (China)', host: 'token-plan-cn' },
    'xiaomi-token-plan-sgp': { name: 'Xiaomi Token Plan (Singapore)', host: 'token-plan-sgp' },
    'xiaomi-token-plan-ams': { name: 'Xiaomi Token Plan (Europe)', host: 'token-plan-ams' },
  };
  for (const [id, { name, host }] of Object.entries(regions)) {
    catalog[id] = {
      ...catalog[id],
      id,
      name,
      api: `https://${host}.xiaomimimo.com/v1`,
      doc: 'https://platform.xiaomimimo.com/#/docs',
      models: {
        'mimo-v2.5-pro': {
          id: 'mimo-v2.5-pro',
          name: 'MiMo-V2.5-Pro',
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 1_048_576, output: 131_072 },
        },
        'mimo-v2.5': {
          id: 'mimo-v2.5',
          name: 'MiMo-V2.5',
          reasoning: true,
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 1_048_576, output: 131_072 },
        },
      },
    };
  }
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(
    generated,
    /"xiaomi-token-plan-cn": \{"id":"xiaomi-token-plan-cn","name":"Xiaomi Token Plan \(China\)","api":"https:\/\/token-plan-cn\.xiaomimimo\.com\/v1"/,
  );
  assert.match(
    generated,
    /"xiaomi-token-plan-sgp": \{"id":"xiaomi-token-plan-sgp","name":"Xiaomi Token Plan \(Singapore\)","api":"https:\/\/token-plan-sgp\.xiaomimimo\.com\/v1"/,
  );
  assert.match(
    generated,
    /"xiaomi-token-plan-ams": \{"id":"xiaomi-token-plan-ams","name":"Xiaomi Token Plan \(Europe\)","api":"https:\/\/token-plan-ams\.xiaomimimo\.com\/v1"/,
  );
  assert.match(generated, /"mimo-v2\.5-pro": \{"displayName":"MiMo-V2\.5-Pro"/);
});

test('sync-model-metadata keeps Z.AI direct API separate from its coding plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog.zai = {
    id: 'zai',
    name: 'Z.AI',
    api: 'https://api.z.ai/api/paas/v4',
    doc: 'https://docs.z.ai/guides/overview/pricing',
    models: {
      'glm-5.2': {
        id: 'glm-5.2',
        name: 'GLM-5.2',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 1_000_000, output: 131_072 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"zai": \{/);
  assert.match(
    generated,
    /"zai": \{"id":"zai","name":"Z\.AI","api":"https:\/\/api\.z\.ai\/api\/paas\/v4"/,
  );
  assert.match(generated, /"glm-5\.2": \{"displayName":"GLM-5\.2"/);
  assert.doesNotMatch(generated, /"zai": \{"id":"zai"[^\n]*api\.z\.ai\/api\/coding\/paas\/v4/);
});

test('sync-model-metadata vendors ZenMux provider facts and exact creator/model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog.zenmux = {
    ...catalog.zenmux,
    name: 'ZenMux',
    api: 'https://zenmux.ai/api/v1',
    doc: 'https://docs.zenmux.ai',
    models: {
      'moonshotai/kimi-k2.5': {
        id: 'moonshotai/kimi-k2.5',
        name: 'Kimi K2.5',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 262_000, output: 64_000 },
      },
      'anthropic/claude-sonnet-4.6': {
        id: 'anthropic/claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1_000_000, output: 128_000 },
        provider: { npm: '@ai-sdk/anthropic', api: 'https://zenmux.ai/api/anthropic/v1' },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"zenmux": \{/);
  assert.match(
    generated,
    /"zenmux": \{"id":"zenmux","name":"ZenMux","api":"https:\/\/zenmux\.ai\/api\/v1"/,
  );
  assert.match(generated, /"moonshotai\/kimi-k2\.5": \{"displayName":"Kimi K2\.5"/);
  assert.match(
    generated,
    /GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES[\s\S]*"zenmux": \{"anthropic\/claude-sonnet-4\.6":\{"npm":"@ai-sdk\/anthropic","api":"https:\/\/zenmux\.ai\/api\/anthropic\/v1"\}\}/,
  );
});

test('sync-model-metadata keeps GitHub Copilot separate from GitHub Models', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog['github-copilot'] = {
    ...catalog['github-copilot'],
    name: 'GitHub Copilot',
    api: 'https://api.githubcopilot.com',
    doc: 'https://docs.github.com/en/copilot',
    models: {
      'gpt-5.4': {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 400_000, output: 128_000 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"github-copilot": \{/);
  assert.match(
    generated,
    /"github-copilot": \{"id":"github-copilot","name":"GitHub Copilot","api":"https:\/\/api\.githubcopilot\.com"/,
  );
  assert.match(generated, /"gpt-5\.4": \{"displayName":"GPT-5\.4"/);
  assert.doesNotMatch(generated, /models\.github\.ai\/inference/);
});

test('sync-model-metadata vendors Cerebras provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog.cerebras = {
    ...catalog.cerebras,
    name: 'Cerebras',
    doc: 'https://inference-docs.cerebras.ai/models/overview',
    models: {
      'gpt-oss-120b': {
        id: 'gpt-oss-120b',
        name: 'GPT OSS 120B',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 131_072, output: 40_960 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"cerebras": \{/);
  assert.match(generated, /"cerebras": \{"id":"cerebras","name":"Cerebras"/);
  assert.match(generated, /"gpt-oss-120b": \{"displayName":"GPT OSS 120B"/);
});

test('sync-model-metadata vendors Tencent TokenHub provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog['tencent-tokenhub'] = {
    ...catalog['tencent-tokenhub'],
    name: 'Tencent TokenHub',
    api: 'https://tokenhub.tencentmaas.com/v1',
    doc: 'https://cloud.tencent.com/document/product/1823/130050',
    models: {
      hy3: {
        id: 'hy3',
        name: 'Hy3',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 256_000, output: 64_000 },
      },
      'hy3-preview': {
        id: 'hy3-preview',
        name: 'Hy3 preview',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 256_000, output: 64_000 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"tencent-tokenhub": \{/);
  assert.match(
    generated,
    /"tencent-tokenhub": \{"id":"tencent-tokenhub","name":"Tencent TokenHub","api":"https:\/\/tokenhub\.tencentmaas\.com\/v1"/,
  );
  assert.match(generated, /"hy3": \{"displayName":"Hy3"/);
  assert.match(generated, /"hy3-preview": \{"displayName":"Hy3 preview"/);
});

test('sync-model-metadata vendors Tencent Coding Plan provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog['tencent-coding-plan'] = {
    ...catalog['tencent-coding-plan'],
    name: 'Tencent Coding Plan (China)',
    api: 'https://api.lkeap.cloud.tencent.com/coding/v3',
    doc: 'https://cloud.tencent.com/document/product/1772/128947',
    models: {
      'tc-code-latest': {
        id: 'tc-code-latest',
        name: 'Auto',
        reasoning: false,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 131_072, output: 16_384 },
      },
      'glm-5': {
        id: 'glm-5',
        name: 'GLM-5',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 202_752, output: 16_384 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"tencent-coding-plan": \{/);
  assert.match(
    generated,
    /"tencent-coding-plan": \{"id":"tencent-coding-plan","name":"Tencent Coding Plan \(China\)","api":"https:\/\/api\.lkeap\.cloud\.tencent\.com\/coding\/v3"/,
  );
  assert.match(generated, /"tc-code-latest": \{"displayName":"Auto"/);
  assert.match(generated, /"glm-5": \{"displayName":"GLM-5"/);
});

test('sync-model-metadata vendors Tencent Token Plan provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog['tencent-token-plan'] = {
    ...catalog['tencent-token-plan'],
    name: 'Tencent Token Plan',
    api: 'https://api.lkeap.cloud.tencent.com/plan/v3',
    doc: 'https://cloud.tencent.com/document/product/1823/130060',
    models: {
      hy3: {
        id: 'hy3',
        name: 'Hy3',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 256_000, output: 64_000 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"tencent-token-plan": \{/);
  assert.match(
    generated,
    /"tencent-token-plan": \{"id":"tencent-token-plan","name":"Tencent Token Plan","api":"https:\/\/api\.lkeap\.cloud\.tencent\.com\/plan\/v3"/,
  );
  assert.match(generated, /"hy3": \{"displayName":"Hy3"/);
});

test('sync-model-metadata vendors StepFun China direct provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog.stepfun = {
    id: 'stepfun',
    name: 'StepFun (China)',
    api: 'https://api.stepfun.com/v1',
    doc: 'https://platform.stepfun.com/docs/zh/overview/concept',
    models: {
      'step-3.5-flash': {
        id: 'step-3.5-flash',
        name: 'Step 3.5 Flash',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 256_000, output: 256_000 },
      },
      'step-3.7-flash': {
        id: 'step-3.7-flash',
        name: 'Step 3.7 Flash',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 256_000, output: 256_000 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"stepfun": \{/);
  assert.match(
    generated,
    /"stepfun": \{"id":"stepfun","name":"StepFun \(China\)","api":"https:\/\/api\.stepfun\.com\/v1"/,
  );
  assert.match(generated, /"step-3\.5-flash": \{"displayName":"Step 3\.5 Flash"/);
  assert.match(generated, /"step-3\.7-flash": \{"displayName":"Step 3\.7 Flash"/);
});

test('sync-model-metadata vendors StepFun Global direct provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog['stepfun-ai'] = {
    id: 'stepfun-ai',
    name: 'StepFun (Global)',
    api: 'https://api.stepfun.ai/v1',
    doc: 'https://platform.stepfun.ai/docs/en/overview/concept',
    models: {
      'step-3.5-flash': {
        id: 'step-3.5-flash',
        name: 'Step 3.5 Flash',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 256_000, output: 256_000 },
      },
      'step-3.7-flash': {
        id: 'step-3.7-flash',
        name: 'Step 3.7 Flash',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 256_000, output: 256_000 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"stepfun-ai": \{/);
  assert.match(
    generated,
    /"stepfun-ai": \{"id":"stepfun-ai","name":"StepFun \(Global\)","api":"https:\/\/api\.stepfun\.ai\/v1"/,
  );
  assert.match(generated, /"step-3\.5-flash": \{"displayName":"Step 3\.5 Flash"/);
  assert.match(generated, /"step-3\.7-flash": \{"displayName":"Step 3\.7 Flash"/);
});

test('sync-model-metadata vendors StepFun Global Step Plan provider facts and exact model ids', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  const output = join(directory, 'generated.ts');
  const catalog = withRequiredProviders({});
  catalog['stepfun-ai-step-plan'] = {
    id: 'stepfun-ai-step-plan',
    name: 'StepFun Step Plan (Global)',
    api: 'https://api.stepfun.ai/step_plan/v1',
    doc: 'https://platform.stepfun.ai/docs/en/step-plan/integrations/reasoning-api',
    models: {
      'step-3.5-flash': {
        id: 'step-3.5-flash',
        name: 'Step 3.5 Flash',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 256_000, output: 256_000 },
      },
      'step-3.5-flash-2603': {
        id: 'step-3.5-flash-2603',
        name: 'Step 3.5 Flash 2603',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 256_000, output: 256_000 },
      },
      'step-3.7-flash': {
        id: 'step-3.7-flash',
        name: 'Step 3.7 Flash',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image', 'video'], output: ['text'] },
        limit: { context: 256_000, output: 256_000 },
      },
    },
  };
  await writeFile(input, JSON.stringify(catalog));

  await execFileAsync(process.execPath, [
    'scripts/sync-model-metadata.mjs',
    '--input',
    input,
    '--output',
    output,
  ]);

  const generated = await readFile(output, 'utf8');
  assert.match(generated, /"stepfun-ai-step-plan": \{/);
  assert.match(
    generated,
    /"stepfun-ai-step-plan": \{"id":"stepfun-ai-step-plan","name":"StepFun Step Plan \(Global\)","api":"https:\/\/api\.stepfun\.ai\/step_plan\/v1"/,
  );
  assert.match(generated, /"step-3\.5-flash": \{"displayName":"Step 3\.5 Flash"/);
  assert.match(generated, /"step-3\.5-flash-2603": \{"displayName":"Step 3\.5 Flash 2603"/);
  assert.match(generated, /"step-3\.7-flash": \{"displayName":"Step 3\.7 Flash"/);
});

test('sync-model-metadata rejects incomplete upstream model data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  await writeFile(
    input,
    JSON.stringify(
      withRequiredProviders({
        doc: 'https://example.com/models',
        models: { broken: { name: 'Broken' } },
      }),
    ),
  );

  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/sync-model-metadata.mjs', '--input', input]),
    /unsupported shape/,
  );
});

test('sync-model-metadata rejects a missing configured provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-model-metadata-'));
  const input = join(directory, 'api.json');
  await writeFile(input, JSON.stringify({ openai: { doc: 'https://example.com', models: {} } }));

  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/sync-model-metadata.mjs', '--input', input]),
    /provider anthropic is missing/,
  );
});

test('sync-model-metadata rejects an option without a value', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/sync-model-metadata.mjs', '--output']),
    /--output requires a value/,
  );
});
