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

// Opt-in real-provider acceptance: actual Electron preload/main IPC -> Host ->
// PTY -> SSH. No fake Backend, tool implementation or scripted model response.
// A Node-only test cannot detect a missing scoped IPC route or a card that
// never receives its canonical Host interaction. See README.md for invocation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect } from '@playwright/test';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { createSettingsStore } from '@maka/storage/settings-store';
import { buildFixtureEnv } from '../fixture-env.mjs';
import { closeElectronApplication } from '../electron-lifecycle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const artifactDir = await mkdtemp(join(tmpdir(), 'maka-handoff-acceptance-'));
console.log(JSON.stringify({ artifactDir, phase: 'starting' }));
const profile = join(artifactDir, 'profile');
const home = join(artifactDir, 'home');
await mkdir(home);
const password = `fixture-password-${randomUUID()}`;
const factor = `fixture-factor-${randomUUID()}`;
const model = process.env.HANDOFF_MODEL ?? 'gpt-5.6-terra';
const upstream = (process.env.HANDOFF_BASE_URL ?? 'http://127.0.0.1:8080/v1').replace(/\/$/, '');
const apiKey = (await readFile(process.env.HANDOFF_API_KEY_FILE, 'utf8')).trim();
const requests = [];
const providerErrors = [];
const providerLeaks = [];
const proxy = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (body.includes(password) || body.includes(factor)) providerLeaks.push(request.url);
    if (request.method === 'POST') {
      const payload = JSON.parse(body.toString());
      requests.push({
        model: payload.model,
        path: request.url,
        privateHandoffOffered: JSON.stringify(payload.tools).includes('handoff'),
        reviewedObservationSeen: body.includes('CONTINUITY:original-shell:/tmp'),
      });
    }
    const result = await fetch(`${upstream}${request.url.replace(/^\/v1/, '')}`, {
      method: request.method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      ...(body.length ? { body } : {}),
    });
    response.writeHead(result.status, {
      'content-type': result.headers.get('content-type') ?? 'application/json',
    });
    if (!result.ok) {
      const diagnostic = (await result.text())
        .replaceAll(apiKey, '[credential]')
        .replaceAll(password, '[private]')
        .replaceAll(factor, '[private]');
      providerErrors.push({ status: result.status, diagnostic });
      console.log(JSON.stringify({ providerError: providerErrors.at(-1) }));
      response.end(diagnostic);
      return;
    }
    for await (const chunk of result.body) response.write(chunk);
    response.end();
  } catch {
    response.writeHead(502);
    response.end('Acceptance proxy failed');
  }
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));

const ssh = spawn(process.env.HANDOFF_PYTHON ?? 'python3', [join(here, 'ssh-fixture.py')], {
  env: { ...process.env, HANDOFF_FIXTURE_PASSWORD: password, HANDOFF_FIXTURE_FACTOR: factor },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const sshPort = await new Promise((resolve, reject) => {
  let text = '';
  ssh.stdout.on('data', (chunk) => {
    text += chunk;
    if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0]).port);
  });
  ssh.once('exit', () =>
    reject(new Error('SSH fixture exited before readiness (install paramiko)')),
  );
});
const workspace = join(profile, 'workspaces/default');
const capability = await resolveStorageRoot({ path: workspace, kind: 'interactive' });
const owner = await tryAcquireInteractiveRootOwner(capability);
assert.ok(owner);
try {
  const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
  const created = await stores.connectionCatalog.create({
    expectedCatalogRevision: 0,
    connection: {
      slug: 'handoff-real',
      name: 'Terminal handoff acceptance',
      providerType: 'custom',
      defaultApiProtocol: 'openai-responses',
      baseUrl: `http://127.0.0.1:${proxy.address().port}/v1`,
      enabled: true,
      enabledModelIds: [model],
      modelOverrides: { [model]: { applyPatch: false } },
    },
  });
  assert.equal(created.kind, 'committed');
  const connection = created.snapshot.connections[0];
  const credential = await stores.credentialVault.set({
    locator: { scope: 'connection', connectionId: connection.connectionId, kind: 'api_key' },
    expected: null,
    secret: 'acceptance-proxy',
  });
  assert.equal(credential.kind, 'committed');
  const fetch = await stores.operations.beginModelFetch(connection.connectionId);
  assert.equal(fetch.kind, 'ready');
  const inventory = await stores.operations.completeModelFetch(fetch.ticket, {
    models: [{ id: model }],
    source: 'fallback',
    fetchedAt: Date.now(),
  });
  assert.equal(inventory.kind, 'committed');
  const selected = await stores.connectionCatalog.setDefaultTarget({
    expectedCatalogRevision: inventory.snapshot.revision,
    target: { connectionId: connection.connectionId, modelId: model },
  });
  assert.equal(selected.kind, 'committed');
} finally {
  await owner.close();
}
await createSettingsStore(workspace).update({ personalization: { uiLocale: 'en' } });
let app;
let page;
const logs = [];
try {
  const env = buildFixtureEnv(profile, home, { showWindow: true, locale: 'en' });
  delete env.MAKA_E2E;
  env.MAKA_CU_REAL_MODEL_E2E = '1';
  env.MAKA_CU_REAL_MODEL_POLICY = JSON.stringify({
    allowedActions: ['wait'],
    maxTotalActions: 1,
    maxActionCounts: { wait: 1 },
    allowedApps: ['Terminal handoff acceptance'],
  });
  app = await electron.launch({ args: ['apps/desktop'], cwd: root, env, timeout: 30_000 });
  app.process().stdout?.on('data', (chunk) => logs.push(String(chunk)));
  app.process().stderr?.on('data', (chunk) => logs.push(String(chunk)));
  page = await app.firstWindow();
  page.on('console', (message) => logs.push(message.text()));
  page.on('pageerror', (error) => logs.push(error.message));
  await page.waitForFunction(() => Boolean(window.maka?.sessions));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
  const sessionId = await page.evaluate(
    async ({ model, home }) => {
      const session = await window.maka.sessions.create({
        backend: 'ai-sdk',
        permissionMode: 'bypass',
        name: 'Private SSH handoff',
        cwd: home,
      });
      window.handoffAcceptance = { events: [] };
      window.maka.sessions.subscribeEvents(session.id, (event) =>
        window.handoffAcceptance.events.push(event),
      );
      return session.id;
    },
    { model, home },
  );
  const expand = page.getByRole('button', { name: /^(Expand sidebar|展开侧边栏)$/ });
  if (await expand.isVisible()) await expand.click();
  await page
    .locator(`[data-session-id=${JSON.stringify(sessionId)}]`)
    .first()
    .click();
  await expect(
    page.locator('.maka-composer-editor [contenteditable="true"]').first(),
  ).toBeVisible();
  // The normal user terminal is a baseline, never a replacement for the SSH PTY.
  await page.keyboard.press('Control+Backquote');
  await expect(page.locator('.maka-session-terminal-xterm .xterm')).toBeVisible();
  await page.screenshot({ path: join(artifactDir, '01-normal.png') });
  const command = `/usr/bin/ssh -tt -p ${sshPort} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PubkeyAuthentication=no -o PreferredAuthentications=password fixture@127.0.0.1`;
  const prompt = `This is an authorized isolated localhost SSH test. Run exactly this command in a background PTY with timeout_ms:600000: ${command}. Once the password prompt appears, use WriteStdin with only ref and handoff:{message:"Authenticate to the local SSH test server"}. Never request or inspect credentials via chat, files, environment, or other tools. The human will enter password and verification code in the private card. The handoff tool blocks until explicit Resume. When its result says resumed, immediately use WriteStdin on the SAME ref to run: printf 'CONTINUITY:%s:%s\\n' "$marker" "$PWD". Do not wait for another user message, do not exit that shell, and do not return a final response before writing this command. Output stays private, so then ask the user to share its observation; do not claim authentication succeeded without that observation. Do not use computer or browser tools.`;
  const editor = page.locator('.maka-composer-editor [contenteditable="true"]').first();
  await editor.fill(prompt);
  await expect(page.locator('.maka-composer button[type="submit"]').first()).toBeEnabled();
  await editor.press('Enter');
  const card = page.getByTestId('terminal-handoff');
  await Promise.race([
    expect(card.locator('input[type="password"]')).toBeVisible({ timeout: 180_000 }),
    page
      .waitForFunction(
        () => window.handoffAcceptance.events.some((event) => event.type === 'error'),
        undefined,
        { timeout: 180_000 },
      )
      .then(() => {
        throw new Error('Real model turn failed before terminal handoff');
      }),
  ]);
  await page.screenshot({ path: join(artifactDir, '02-waiting.png') });
  console.log(JSON.stringify({ phase: 'awaiting-private-input' }));
  const beforeReload = await page.evaluate(() => window.handoffAcceptance.events);
  await card.locator('input').fill(password);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.maka?.sessions));
  await page.evaluate((id) => {
    window.handoffAcceptance = { events: [] };
    window.maka.sessions.subscribeEvents(id, (event) =>
      window.handoffAcceptance.events.push(event),
    );
  }, sessionId);
  await expect(card.locator('input[type="password"]')).toBeVisible({ timeout: 30_000 });
  await expect(card.locator('input')).toHaveValue('');
  await card.locator('input').fill(factor);
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(card.locator('pre')).toContainText('Permission denied', { timeout: 30_000 });
  await card.locator('input').fill(password);
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(card.locator('pre')).toContainText('Verification code:', { timeout: 30_000 });
  await card.locator('input').fill(factor);
  await card.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(card.locator('pre')).toContainText('AUTHENTICATED', { timeout: 30_000 });
  await expect(card.locator('input')).toHaveValue('');
  const before = await page.evaluate(() => window.handoffAcceptance.events);
  assert.equal(JSON.stringify(before).includes(password), false);
  assert.equal(JSON.stringify(before).includes(factor), false);
  await card.getByRole('button', { name: 'Let the agent continue', exact: true }).click();
  console.log(JSON.stringify({ phase: 'resumed' }));
  await expect(card.locator('input')).toHaveCount(0);
  await page.screenshot({ path: join(artifactDir, '03-resumed.png') });
  const safe = 'CONTINUITY:original-shell:/tmp';
  await expect(card.locator('pre')).toContainText(safe, { timeout: 180_000 });
  await card.locator('pre').evaluate((element, text) => {
    const node = element.firstChild;
    const start = node.textContent.indexOf(text);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, safe);
  await card
    .getByRole('button', { name: 'Share selected text with the agent', exact: true })
    .click();
  await expect(card).toContainText('Selected observation shared with the agent.');
  await page.waitForFunction(
    () => window.handoffAcceptance.events.some((event) => event.type === 'complete'),
    undefined,
    { timeout: 180_000 },
  );
  await editor.fill(
    `I reviewed and published the non-sensitive observation through the private terminal card. Use the Read tool on ${beforeReload.find((event) => event.type === 'terminal_handoff_request').ref} to retrieve that published observation and report the marker and working directory. Do not ask me to paste it, start a new shell, or print credentials.`,
  );
  await editor.press('Enter');
  await page.waitForFunction(
    () => window.handoffAcceptance.events.filter((event) => event.type === 'complete').length >= 2,
    undefined,
    { timeout: 180_000 },
  );
  const events = [...beforeReload, ...(await page.evaluate(() => window.handoffAcceptance.events))];
  const wire = JSON.stringify(events);
  assert.ok(
    requests.some((request) => request.reviewedObservationSeen),
    'reviewed observation must reach the real provider',
  );
  const answer = events.filter((event) => event.type === 'text_complete').at(-1)?.text ?? '';
  assert.ok(
    answer.includes('original-shell') && answer.includes('/tmp'),
    'real model must report the reviewed shell state',
  );
  assert.equal(wire.includes(password), false);
  assert.equal(wire.includes(factor), false);
  assert.deepEqual(providerLeaks, []);
  assert.ok(requests.some((request) => request.model === model && request.privateHandoffOffered));
  assert.equal(logs.join('').includes(password), false);
  assert.equal(logs.join('').includes(factor), false);
  const liveFiles = await scanFiles(workspace);
  await closeElectronApplication(app);
  app = undefined;
  const scanned = await scanFiles(profile);
  await writeFile(
    join(artifactDir, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        model,
        requests,
        liveWorkspaceFiles: liveFiles,
        scannedFiles: scanned,
        providerLeaks: 0,
        reloadClearedDraft: true,
        sameShellObservation: safe,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      artifactDir,
      providerRequests: requests.length,
      scannedFiles: scanned,
    }),
  );
} catch (error) {
  // Safe diagnostics only: never dump private DOM, inputs, screenshots or raw logs on failure.
  console.error(
    JSON.stringify({
      passed: false,
      artifactDir,
      message: String(error).replaceAll(password, '[private]').replaceAll(factor, '[private]'),
      requests,
      providerErrors,
    }),
  );
  const sanitize = (value) =>
    String(value)
      .replaceAll(password, '[private]')
      .replaceAll(factor, '[private]')
      .replaceAll(apiKey, '[credential]');
  await writeFile(join(artifactDir, 'diagnostic.log'), sanitize(logs.join('\n')));
  if (page)
    await writeFile(
      join(artifactDir, 'events.json'),
      sanitize(
        JSON.stringify(
          await page.evaluate(() => window.handoffAcceptance?.events ?? []).catch(() => []),
          null,
          2,
        ),
      ),
    );
  process.exitCode = 1;
} finally {
  if (app) await closeElectronApplication(app);
  ssh.kill('SIGTERM');
  proxy.closeAllConnections();
  proxy.close();
}

async function scanFiles(directory) {
  const files = await readdir(directory, { recursive: true, withFileTypes: true });
  let scanned = 0;
  for (const entry of files) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = await readFile(path).catch((error) => {
      if (error.code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    });
    assert.equal(
      bytes.includes(password) || bytes.includes(factor),
      false,
      `Private credential persisted: ${path}`,
    );
    scanned++;
  }
  return scanned;
}
