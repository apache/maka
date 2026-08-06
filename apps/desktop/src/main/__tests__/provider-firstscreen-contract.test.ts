import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { RECOMMENDED_PROVIDER_TYPES, type ProviderType } from '@maka/core';
import { build } from 'vite';
import { FIRST_RUN_PROVIDER_TYPES } from '../../renderer/onboarding-provider-types.js';
import { providerDisplay } from '../../renderer/settings/provider-display-copy.js';

type RendererChunk = {
  type: 'chunk';
  fileName: string;
  isEntry: boolean;
  imports: string[];
  modules: Record<string, unknown>;
  code: string;
};

const FORBIDDEN_STARTUP_MODULES = [
  'model-metadata.generated',
  'model-metadata',
  'provider-registry',
  'model-catalog',
  'model-thinking',
] as const;

test('unknown providers use their persisted type and generic local copy', () => {
  assert.deepEqual(providerDisplay('future-provider' as ProviderType, 'en'), {
    name: 'future-provider',
    description: 'This provider is not registered in the current build.',
  });
});

test('first-run providers stay aligned with the recommended provider order', () => {
  assert.deepEqual(FIRST_RUN_PROVIDER_TYPES, RECOMMENDED_PROVIDER_TYPES.slice(0, 4));
});

test('renderer startup chunks exclude full model metadata', async () => {
  const output = await build({
    configFile: resolve(process.cwd(), 'vite.config.ts'),
    logLevel: 'silent',
    build: { write: false },
  });
  if (Array.isArray(output) || !('output' in output)) {
    assert.fail('desktop Vite config must produce one renderer output');
  }
  const chunks = output.output.filter((entry) => entry.type === 'chunk') as RendererChunk[];
  const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  const pending = chunks.filter((chunk) => chunk.isEntry);
  const startupChunks: RendererChunk[] = [];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const chunk = pending.pop()!;
    if (visited.has(chunk.fileName)) continue;
    visited.add(chunk.fileName);
    startupChunks.push(chunk);
    for (const imported of chunk.imports) {
      const dependency = byFileName.get(imported);
      if (dependency) pending.push(dependency);
    }
  }

  const forbiddenModules = startupChunks
    .flatMap((chunk) => Object.keys(chunk.modules))
    .filter((moduleId) => FORBIDDEN_STARTUP_MODULES.some((name) =>
      new RegExp(`(?:^|[/\\\\])${name}\\.[cm]?[jt]sx?$`).test(moduleId)
    ));
  assert.deepEqual(forbiddenModules, []);
  assert.doesNotMatch(
    startupChunks.map((chunk) => chunk.code).join('\n'),
    /claude-opus|gpt-5\.|gemini-2\./,
  );
});
