import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from './main-process-contract-source-helpers.js';

test('stable skin parts and formal extension slots are mounted by real renderer components', async () => {
  const chatView = await readFile(
    resolve(REPO_ROOT, 'packages/ui/src/chat-view.tsx'),
    'utf8',
  );
  const composer = await readFile(
    resolve(REPO_ROOT, 'packages/ui/src/composer.tsx'),
    'utf8',
  );
  const composerRegion = await readFile(
    resolve(REPO_ROOT, 'apps/desktop/src/renderer/chat-composer-region.tsx'),
    'utf8',
  );

  for (const part of ['chat', 'chat-header', 'transcript']) {
    assert.match(
      chatView,
      new RegExp(`data-maka-part="${part}"`),
      `ChatView must expose the stable ${part} part`,
    );
  }
  assert.match(composer, /data-maka-part="composer"/);

  for (const slot of [
    'chat-header-before',
    'chat-header-after',
    'transcript-before',
    'transcript-after',
  ]) {
    assert.match(chatView, new RegExp(`data-maka-slot="${slot}"`));
  }
  for (const slot of ['composer-before', 'composer-after']) {
    assert.match(composerRegion, new RegExp(`data-maka-slot="${slot}"`));
  }
});

test('skin action requests are routed through the permission and trusted-gesture host', async () => {
  const host = await readFile(
    resolve(REPO_ROOT, 'apps/desktop/src/renderer/use-skin-action-host.ts'),
    'utf8',
  );
  assert.match(host, /event\.isTrusted/);
  assert.match(host, /authorizeAction\(\s*action,/);
  assert.match(host, /One trusted gesture authorizes at most one action request/);
  assert.match(host, /pending user content|owns staged user content/);
});
