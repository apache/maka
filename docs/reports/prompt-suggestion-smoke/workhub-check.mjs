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
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { buildFixtureEnv } from '../../../scripts/fixture-env.mjs';

const multiline = process.env.MAKA_SMOKE_MULTILINE === '1';
const suggestionText = multiline
  ? '按这个方案实现缓存接口，并补充容量限制、过期清理和并发访问的测试，最后检查边界条件与错误处理是否符合预期，并确认所有测试通过以后再整理修改说明和验证结果。'
  : '按这个方案实现，并补上测试';
const output = resolve(tmpdir(), 'maka-prompt-suggestion-evidence', multiline ? 'multiline' : '.');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'maka-prompt-smoke-'));
await mkdir(join(profile, 'home'));
const requests = [];
let suggestionDelayMs = 0;
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const suggestion = JSON.stringify(body).includes('Predict the single short message');
  requests.push({ path: req.url, suggestion, tools: body.tools, max_tokens: body.max_tokens });
  if (suggestion && suggestionDelayMs)
    await new Promise((resolve) => setTimeout(resolve, suggestionDelayMs));
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/models'))
    return res.end(JSON.stringify({ data: [{ id: 'suggestion-test' }] }));
  res.end(
    JSON.stringify({
      id: 'test-completion',
      object: 'chat.completion',
      created: 1,
      model: 'suggestion-test',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: suggestion ? suggestionText : 'LRU 接口设计' },
        },
      ],
      usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 },
    }),
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const capability = await resolveStorageRoot({
  path: join(profile, 'workspaces/default'),
  kind: 'interactive',
});
const owner = await tryAcquireInteractiveRootOwner(capability);
assert.ok(owner);
const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
const created = await stores.connectionCatalog.create({
  expectedCatalogRevision: 0,
  connection: {
    slug: 'suggestion-test',
    name: 'Suggestion test',
    providerType: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    enabled: true,
    enabledModelIds: ['suggestion-test'],
  },
});
assert.equal(created.kind, 'committed');
const connection = created.snapshot.connections[0];
await stores.credentialVault.set({
  locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
  expected: null,
  secret: 'local-test-only',
});
const ticket = await stores.operations.beginModelFetch(connection.connectionId);
const inventory = await stores.operations.completeModelFetch(ticket.ticket, {
  models: [{ id: 'suggestion-test' }],
  source: 'fallback',
  fetchedAt: Date.now(),
});
await stores.connectionCatalog.setDefaultTarget({
  expectedCatalogRevision: inventory.snapshot.revision,
  target: { connectionId: connection.connectionId, modelId: 'suggestion-test' },
});
await owner.close();
const env = buildFixtureEnv(profile, join(profile, 'home'), { showWindow: true, locale: 'zh-CN' });
const app = await electron.launch({
  args: ['.', `--user-data-dir=${profile}`],
  cwd: resolve('apps/desktop'),
  env,
  timeout: 30000,
});
const page = await app.firstWindow();
await app.evaluate(
  ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800),
  multiline ? 780 : 1180,
);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.waitForFunction(() => Boolean(window.maka?.sessions));
  await page.locator('[data-maka-content-ready]').first().waitFor({ timeout: 30000 });
  await page.evaluate(() => window.maka.settings.updateClient({ workHub: { enabled: true } }));
  let workhub;
  await expect
    .poll(() => {
      workhub = app
        .context()
        .pages()
        .find((candidate) => new URL(candidate.url()).searchParams.get('surface') === 'workhub');
      return Boolean(workhub);
    })
    .toBe(true);
  const input = workhub.locator('.workHubLive .maka-composer-editor [contenteditable="true"]');
  await input.waitFor();
  const sessionId = await workhub.evaluate(() => window.maka.workHub.resolveCoordinationSession());
  await workhub.locator('.maka-composer-plus-menu button').first().click();
  const toggle = workhub.getByRole('menuitemcheckbox', {
    name: /下一步输入建议|Next prompt suggestions/,
  });
  await toggle.waitFor();
  await toggle.click();
  await workhub.keyboard.press('Escape');
  await input.fill('请先设计缓存接口，下一步再实现。');
  await input.press('Enter');
  await expect
    .poll(
      async () => {
        const turns = await workhub.evaluate((id) => window.maka.sessions.listTurns(id), sessionId);
        return turns.some((turn) => turn.status === 'completed');
      },
      { timeout: 20000 },
    )
    .toBe(true);
  const offer = workhub.locator('.maka-composer-next-prompt');
  await offer.waitFor({ timeout: 10000 });
  const result = await workhub.evaluate(
    (id) => window.maka.sessions.generatePromptSuggestion(id),
    sessionId,
  );
  const session = await workhub.evaluate((id) => window.maka.workHub.getSession(id), sessionId);
  const evidence = {
    sessionId,
    role: session.role,
    result,
    predictionRequests: requests.filter((r) => r.suggestion).length,
    offerCount: await workhub.locator('.maka-composer-next-prompt').count(),
    draft: await input.innerText(),
    body: (await workhub.locator('body').innerText()).slice(-3000),
  };
  await writeFile(join(output, 'workhub-check.json'), JSON.stringify(evidence, null, 2) + '\n');
  await workhub.screenshot({ path: join(output, 'workhub-check.png') });
  console.log(JSON.stringify(evidence, null, 2) + '\n');
  assert.equal(result.kind, 'generated');
  assert.equal(evidence.predictionRequests, 1);
  assert.equal(evidence.offerCount, 1);
  await input.press('Tab');
  assert.equal(await input.innerText(), suggestionText);
  assert.equal(await offer.count(), 0);
  const turnsBeforeSend = await workhub.evaluate(
    (id) => window.maka.sessions.listTurns(id),
    sessionId,
  );
  assert.equal(turnsBeforeSend.length, 1, 'Tab must not send');
  await input.press('Meta+z');
  assert.equal(await input.innerText(), '');
  assert.equal(await offer.count(), 0);
  await input.fill('继续设计缓存');
  await input.press('Enter');
  await offer.waitFor({ timeout: 10000 });
  await input.press('Tab');
  await input.press('Enter');
  await offer.waitFor({ timeout: 10000 });
  const transcript = await workhub.evaluate(async (id) => {
    const turns = await window.maka.sessions.listTurns(id);
    return window.maka.transcripts.readTurn(id, turns.at(-1).turnId);
  }, sessionId);
  assert.ok(
    transcript.some((message) => message.type === 'user' && message.text === suggestionText),
  );
  await input.press('Escape');
  assert.equal(await offer.count(), 0);
  suggestionDelayMs = 800;
  const requestCount = requests.filter((r) => r.suggestion).length;
  await input.fill('检查边界条件');
  await input.press('Enter');
  await expect.poll(() => requests.filter((r) => r.suggestion).length).toBe(requestCount + 1);
  await input.fill('我正在写下一句');
  await workhub.evaluate((id) => window.maka.sessions.generatePromptSuggestion(id), sessionId);
  assert.equal(await input.innerText(), '我正在写下一句');
  assert.equal(await offer.count(), 0);
  await input.fill('');
  assert.equal(await offer.count(), 0);
  evidence.checks = [
    'generated through WorkHub IPC and Host',
    'Tab accepts without send',
    'native undo',
    'Enter reaches durable coordination transcript',
    'Esc dismiss',
    'late result preserves draft',
    'no resurrection',
  ];
  evidence.ok = true;
  await writeFile(join(output, 'workhub-check.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('PASS WorkHub acceptance');
} finally {
  await app.close();
  server.close();
}
