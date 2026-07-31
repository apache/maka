import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./cu-real-runtime-model-e2e.mjs', import.meta.url), 'utf8');

test('real Runtime model E2E uses product model and ToolRuntime paths safely', () => {
  assert.match(source, /new AiSdkBackend/);
  assert.match(source, /getAIModel/);
  assert.match(source, /buildComputerUseTools/);
  assert.doesNotMatch(source, /PermissionEngine/);
  assert.match(source, /readExecutionBoundary/);
  assert.match(source, /recordToolInvocation/);
  assert.match(source, /providerType: 'openai'/);
  assert.match(source, /compatibility/);
  assert.match(source, /physical user input/);
  assert.doesNotMatch(source, /cua-driver|Codex CUA Lab\.app|left_click/);
});
