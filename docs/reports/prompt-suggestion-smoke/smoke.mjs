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
  const sessionId = await page.evaluate(async () => {
    const session = await window.maka.sessions.create({ name: 'Prompt suggestion acceptance' });
    return session.id;
  });
  const expand = page.getByRole('button', { name: /^(展开侧边栏|Expand sidebar)$/ });
  if (await expand.isVisible()) await expand.click();
  await page.getByText('Prompt suggestion acceptance', { exact: true }).first().click();
  const input = page.locator('.maka-composer-editor [contenteditable="true"]').first();
  await input.waitFor();
  console.log(
    'session',
    sessionId,
    'initial',
    (await page.locator('body').innerText()).slice(-2500),
  );
  await page.locator('.maka-composer-plus-menu button').first().click();
  await page
    .getByRole('menuitemcheckbox', { name: /下一步输入建议|Next prompt suggestions/ })
    .click();
  await page.keyboard.press('Escape');
  await input.fill('请先设计 LRU 缓存接口，下一步再实现与测试。');
  await page.locator('.maka-composer button[type="submit"]').waitFor();
  await input.press('Enter');
  const offer = page.locator('.maka-composer-next-prompt');
  await offer.waitFor({ timeout: 20000 });
  assert.equal(await input.innerText(), '');
  assert.equal(await offer.locator('.maka-composer-next-prompt-text').innerText(), suggestionText);
  async function textMetrics(selector) {
    return page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const style = getComputedStyle(el);
        return {
          rects: [...range.getClientRects()].map((r) => ({
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
          })),
          font: style.font,
          letterSpacing: style.letterSpacing,
          whiteSpace: style.whiteSpace,
          wordBreak: style.wordBreak,
        };
      });
  }
  const suggestionMetrics = await textMetrics('.maka-composer-next-prompt-text');
  await page.screenshot({ path: join(output, '01-offer.png') });
  await input.press('Tab');
  assert.equal(await input.innerText(), suggestionText);
  assert.equal(await offer.count(), 0);
  if (multiline)
    assert.ok(suggestionMetrics.rects.length > 1, 'long suggestion must actually wrap');
  const acceptedMetrics = await textMetrics('.maka-composer-editor [contenteditable="true"]');
  assert.deepEqual(
    suggestionMetrics,
    acceptedMetrics,
    'suggested and accepted glyph positions and typography must match',
  );
  await writeFile(
    join(output, 'text-alignment.json'),
    JSON.stringify({ suggestionMetrics, acceptedMetrics }, null, 2) + '\n',
  );
  await page.screenshot({ path: join(output, '02-accepted.png') });
  await input.press('Meta+z');
  console.log('undo text', await input.innerText());
  assert.equal(await input.innerText(), '');
  assert.equal(await offer.count(), 0);
  await input.fill('我的自定义下一步');
  await input.press('Enter');
  await offer.waitFor({ timeout: 20000 });
  await input.press('Escape');
  assert.equal(await offer.count(), 0);
  assert.equal(await input.innerText(), '');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const usage = await page.evaluate(
    async (id) => await window.maka.sessions.generatePromptSuggestion(id),
    sessionId,
  );
  assert.equal(usage.kind, 'generated');
  assert.equal(
    requests.filter((r) => r.suggestion).length,
    2,
    'repeat IPC request must reuse result',
  );
  // Accept and submit through the original send path, then confirm durable transcript.
  await input.fill('第三轮：确认接口');
  await input.press('Enter');
  await offer.waitFor({ timeout: 20000 });
  await input.press('Tab');
  await input.press('Enter');
  await offer.waitFor({ timeout: 20000 });
  const snapshot = await page.evaluate((id) => window.maka.sessions.readSnapshot(id), sessionId);
  assert.ok(snapshot.text.includes(suggestionText));
  for (const [width, height, zoom] of [
    [900, 650, 1.25],
    [780, 600, 0.9],
    [1180, 800, 1],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setSize(size[0], size[1]);
        w.webContents.setZoomFactor(size[2]);
      },
      [width, height, zoom],
    );
    const bounds = await offer.boundingBox();
    assert.ok(bounds && bounds.width > 100);
    assert.ok(await offer.isVisible());
  }
  await page.screenshot({ path: join(output, '03-after-send.png') });
  await input.fill('自行输入会隐藏建议');
  assert.equal(await offer.count(), 0);
  await input.fill('');
  assert.equal(await offer.count(), 0);
  // Delayed provider response must not replace a newer draft or revive when it is erased.
  suggestionDelayMs = 800;
  const previousRequests = requests.filter((r) => r.suggestion).length;
  await input.fill('第五轮：生成一个延迟建议');
  await input.press('Enter');
  await expect.poll(() => requests.filter((r) => r.suggestion).length).toBe(previousRequests + 1);
  await input.fill('我已经开始写自己的下一句');
  await page.evaluate((id) => window.maka.sessions.generatePromptSuggestion(id), sessionId);
  assert.equal(await input.innerText(), '我已经开始写自己的下一句');
  assert.equal(await offer.count(), 0);
  await input.fill('');
  assert.equal(await offer.count(), 0);
  // Turning the feature off prevents the next completed turn from spending a request.
  await page.locator('.maka-composer-plus-menu button').first().click();
  await page
    .getByRole('menuitemcheckbox', { name: /下一步输入建议|Next prompt suggestions/ })
    .click();
  await page.keyboard.press('Escape');
  const beforeDisabled = requests.filter((r) => r.suggestion).length;
  await input.fill('关闭建议之后的正常对话');
  await input.press('Enter');
  await expect
    .poll(async () => {
      const turns = await page.evaluate((id) => window.maka.sessions.listTurns(id), sessionId);
      return turns.length >= 6 && turns.at(-1).status === 'completed';
    })
    .toBe(true);
  assert.equal(requests.filter((r) => r.suggestion).length, beforeDisabled);
  assert.equal(await offer.count(), 0);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        ok: true,
        profile,
        sessionId,
        requests,
        errors,
        checks: [
          'empty ghost text',
          'Tab accepts without send',
          'native undo',
          'Esc dismiss',
          'deduplicated IPC',
          'accepted Enter reaches durable transcript',
          'three viewport/zoom combinations',
          'typing hides suggestion without resurrection',
          'late response preserves new draft',
          'disabled makes no prediction request',
        ],
      },
      null,
      2,
    ) + '\n',
  );
  console.log('PASS', output);
} catch (e) {
  console.error('FAIL', e);
  console.error('BODY', (await page.locator('body').innerText()).slice(-6000));
  console.error('REQUESTS', JSON.stringify(requests));
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw e;
} finally {
  await app.close();
  server.close();
}
