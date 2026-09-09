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

import { resolve } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { COMPOSER_INPUT, awaitSendReady, ensureSidebarExpanded, expect, test } from './fixtures';

test('a locally saved message survives renderer and application restart, then executes once', async ({
  sessionLocalWindow,
}, testInfo) => {
  let { page } = sessionLocalWindow;
  const { app, restart } = sessionLocalWindow;
  const first = 'durable history before restart';
  await page.locator(COMPOSER_INPUT).fill(first);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText(`Fake backend received: ${first}`)).toBeVisible();
  await ensureSidebarExpanded(page);
  const sessionId = await page
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => !!(await window.maka.sessionLocal.readTranscript(id)),
        sessionId!,
      ),
    )
    .toBe(true);

  // Pause only the delivery scheduler in this isolated main process. Admission,
  // SQLite, renderer/preload, and the later Host execution all remain real.
  await app.evaluate((_electron, modulePath) => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { DesktopSessionLocalService } = require(modulePath);
    DesktopSessionLocalService.prototype.wake = () => {};
  }, resolve('dist/main/session-local-service.js'));
  const pending = 'saved locally across a complete application restart';
  await page.locator(COMPOSER_INPUT).fill(pending);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('');
  await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
  const before = await page.evaluate((id) => window.maka.sessionLocal.listMessages(id), sessionId!);
  const message = before.find((item) => item.text === pending)!;
  expect(message.state).toBe('saved');
  await page.screenshot({ path: testInfo.outputPath('locally-saved.png') });

  await page.reload();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
  expect(
    (await page.evaluate((id) => window.maka.sessionLocal.listMessages(id), sessionId!)).find(
      (item) => item.text === pending,
    )?.messageId,
  ).toBe(message.messageId);

  page = await restart();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${pending}`),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${pending}`),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => (await window.maka.sessionLocal.listMessages(id)).length,
        sessionId!,
      ),
    )
    .toBe(0);
  await page.screenshot({ path: testInfo.outputPath('recovered.png') });
});

test('cached history remains readable when the live transcript endpoint is unavailable', async ({
  sessionLocalWindow,
}, testInfo) => {
  const { page, app } = sessionLocalWindow;
  const prompt = 'history available without a live transcript';
  await page.locator(COMPOSER_INPUT).fill(prompt);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${prompt}`),
  ).toBeVisible();
  await ensureSidebarExpanded(page);
  const sessionId = await page
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  await expect
    .poll(() =>
      page.evaluate(
        async (id) => !!(await window.maka.sessionLocal.readTranscript(id)),
        sessionId!,
      ),
    )
    .toBe(true);
  // Fault only the live endpoint, not the cache bridge or renderer projection.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('sessions:transcript:open');
    ipcMain.handle('sessions:transcript:open', () => {
      throw new Error('E2E live transcript unavailable');
    });
  });
  await page.reload();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${prompt}`),
  ).toBeVisible();
  await expect(page.locator('.maka-chat-recovery-notice')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('cached-history.png') });
});

test('a new task is readable locally before the Host session exists', async ({
  sessionLocalWindow,
}) => {
  let { page } = sessionLocalWindow;
  await sessionLocalWindow.app.evaluate((_electron, modulePath) => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { DesktopSessionLocalService } = require(modulePath);
    DesktopSessionLocalService.prototype.wake = () => {};
  }, resolve('dist/main/session-local-service.js'));
  const prompt = 'first message saved before Host creation';
  await page.locator(COMPOSER_INPUT).fill(prompt);
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('');
  await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
  await ensureSidebarExpanded(page);
  const sessionId = await page
    .locator('[data-session-id]:has([aria-current="page"])')
    .getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  await expect(page.getByText('读取任务失败', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Graph 状态刷新失败。', { exact: true })).toHaveCount(0);
  await page.reload();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(page.getByText('等待发送', { exact: true })).toBeVisible();
  await expect(page.getByText('读取任务失败', { exact: true })).toHaveCount(0);
  page = await sessionLocalWindow.restart();
  await ensureSidebarExpanded(page);
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${prompt}`),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByLabel('Maka 的回答').getByText(`Fake backend received: ${prompt}`),
  ).toHaveCount(1);
});


test('a failed message restores its durable attachment without replacing a newer draft', async ({
  sessionLocalWindow,
}, testInfo) => {
  const { page, app } = sessionLocalWindow;
  await page.locator(COMPOSER_INPUT).fill('history before failed delivery');
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText('Fake backend received: history before failed delivery')).toBeVisible();
  // Dismiss unrelated first-session observation errors before capturing recovery.
  for (const notice of await page.getByRole('button', { name: '关闭通知', exact: true }).all()) {
    await notice.click();
  }
  await ensureSidebarExpanded(page);
  const sessionId = (await page.locator('[data-session-id]:has([aria-current="page"])').getAttribute('data-session-id'))!;

  // Fail before attachment ingestion. Recovery must use SQLite's bytes through
  // the real Main/preload bridge, not an optimistic renderer attachment cache.
  await app.evaluate((_electron, modulePath) => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { DesktopSessionLocalStore } = require(modulePath);
    const enqueue = DesktopSessionLocalStore.prototype.enqueue;
    DesktopSessionLocalStore.prototype.enqueue = function (partition, input) {
      const record = enqueue.call(this, partition, input);
      if (input.command.messageId === 'e2e-failed-message') {
        this.update({ ...record, state: 'failed', error: 'E2E definite preparation failure' });
      }
      return record;
    };
  }, resolve('dist/main/session-local-store.js'));
  await page.evaluate(async (id) => {
    await window.maka.sessions.submitMessage(id, 'current_turn', {
      messageId: 'e2e-failed-message', text: 'recover this original message',
      attachmentItems: [{ file: new File(['durable recovery bytes'], 'recovery.txt', { type: 'text/plain' }) }],
    });
  }, sessionId);
  await expect(page.getByText('消息未发送', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('failed-message.png') });

  const canonical = await page.locator('.maka-turn').first().boundingBox();
  const local = await page.locator('.maka-transient-message').filter({ hasText: 'recover this original message' }).boundingBox();
  expect(canonical).toBeTruthy();
  expect(local).toBeTruthy();
  expect(Math.abs(local!.x - canonical!.x)).toBeLessThan(1);
  expect(Math.abs(local!.width - canonical!.width)).toBeLessThan(1);

  // Hold the authoritative read while the user starts another draft. It must
  // be checked again after IPC.
  await app.evaluate((_electron, modulePath) => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { DesktopSessionLocalService } = require(modulePath);
    const read = DesktopSessionLocalService.prototype.readFailedMessage;
    DesktopSessionLocalService.prototype.readFailedMessage = async function (...args) {
      const draft = read.apply(this, args);
      await new Promise((resolve) => setTimeout(resolve, 700));
      return draft;
    };
  }, resolve('dist/main/session-local-service.js'));
  await page.getByRole('button', { name: '编辑后重发', exact: true }).click();
  await page.locator(COMPOSER_INPUT).fill('new draft must survive');
  await expect(page.getByText('请先完成或清空输入框中的草稿、附件和引用，再编辑这条消息。')).toBeVisible();
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('new draft must survive');
  await page.locator(COMPOSER_INPUT).fill('');
  await page.getByRole('button', { name: '编辑后重发', exact: true }).click();
  await expect(page.locator(COMPOSER_INPUT)).toHaveText('recover this original message');
  await expect(page.getByText('recovery.txt', { exact: true })).toBeVisible();
  const draft = await page.evaluate((id) => window.maka.sessionLocal.readFailedMessage(id, 'e2e-failed-message'), sessionId);
  expect(Array.from(draft.stagedAttachments[0]!.content)).toEqual(Array.from(Buffer.from('durable recovery bytes')));
  await page.screenshot({ path: testInfo.outputPath('restored-draft.png') });

  await page.locator(COMPOSER_INPUT).fill('edited recovery message');
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByLabel('Maka 的回答').getByText('Fake backend received: edited recovery message')).toBeVisible();
  await expect(page.getByLabel('Maka 的回答').getByText('Fake backend received: edited recovery message')).toHaveCount(1);
  await expect(page.locator('.maka-turn').filter({ hasText: 'edited recovery message' }).getByText('recovery.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('消息未发送', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除失败消息', exact: true }).click();
  await expect(page.getByText('消息未发送', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Maka 的回答').getByText('Fake backend received: edited recovery message')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('resent-message.png') });

  // A Stop retracts pending follow-ups. A later local presentation refresh
  // must not republish their historical admission receipts as waiting rows.
  await page.locator(COMPOSER_INPUT).fill('__e2e_hold_open__');
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText('Fake backend waiting for the test to stop the Turn.', { exact: true })).toBeVisible();
  await page.locator(COMPOSER_INPUT).fill('queued recovery follow-up');
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText('已排队，等待下一轮回复', { exact: true })).toBeVisible();
  await page.locator(COMPOSER_INPUT).press('Escape');
  await expect(page.getByText('已中断', { exact: true })).toBeVisible();
  await page.locator(COMPOSER_INPUT).fill('continue after recovery stop');
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText('Fake backend received: continue after recovery stop', { exact: true })).toBeVisible();
  await expect(page.getByText('正在处理这条消息', { exact: true })).toHaveCount(0);
  await expect(page.locator('.maka-transient-message').filter({ hasText: 'queued recovery follow-up' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('stopped-queue-retired.png') });

  // A visible live reply is not yet proof that the offline transcript was saved.
  await expect.poll(() => app.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(require('node:path').join(require('electron').app.getPath('userData'), 'session-experience.sqlite'), { readOnly: true });
    try {
      // This fixture owns one Session. Renderer ids include a Host prefix,
      // while SQLite stores the raw Host Session id.
      return db.prepare('SELECT snapshot FROM transcripts').all()
        .some((row) => row.snapshot.includes('continue after recovery stop'));
    } finally { db.close(); }
  })).toBe(true);

  // Disable Host reads before navigation: only the local durable state can
  // suppress the cancelled message now, not a successful cancellation query.
  await makeHostUnavailable(app);
  await ensureSidebarExpanded(page);
  await page.getByRole('button', { name: '新任务', exact: true }).click();
  await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect.poll(() => page.evaluate(async (id) =>
    (await window.maka.sessionLocal.listMessages(id)).some((message) => message.text === 'queued recovery follow-up'), sessionId,
  )).toBe(false);
  await expect(page.getByText('queued recovery follow-up', { exact: true })).toHaveCount(0);
  const restarted = await sessionLocalWindow.restart(makeHostUnavailable);
  // Force a fresh renderer after installing the offline fault at startup.
  await restarted.reload();
  await ensureSidebarExpanded(restarted);
  await restarted.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect.poll(() => restarted.evaluate(async (id) =>
    (await window.maka.sessionLocal.listMessages(id)).some((message) => message.text === 'queued recovery follow-up'), sessionId,
  )).toBe(false);
  await expect(restarted.getByText('queued recovery follow-up', { exact: true })).toHaveCount(0);
  await expect(restarted.getByText('continue after recovery stop', { exact: true })).toBeVisible();
  const proofUnavailable = await restarted.evaluate(async (id) => {
    try { await window.maka.sessions.queryCancelledMessages(id, ['unavailable-probe']); return false; }
    catch { return true; }
  }, sessionId);
  expect(proofUnavailable).toBe(true);
  await restarted.screenshot({ path: testInfo.outputPath('stopped-queue-offline-restart.png') });
});

test('one-shot orchestration survives the actual composer send, edit and resend path', async ({ sessionLocalWindow }) => {
  const { page, app } = sessionLocalWindow;
  await page.locator(COMPOSER_INPUT).fill('history before orchestration recovery');
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText('Fake backend received: history before orchestration recovery')).toBeVisible();
  await expect(page.getByText('正在处理这条消息', { exact: true })).toHaveCount(0);
  await ensureSidebarExpanded(page);
  const sessionId = (await page.locator('[data-session-id]:has([aria-current="page"])').getAttribute('data-session-id'))!;
  await app.evaluate((_electron, modulePath) => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { DesktopSessionLocalStore } = require(modulePath);
    const enqueue = DesktopSessionLocalStore.prototype.enqueue;
    DesktopSessionLocalStore.prototype.enqueue = function (partition, input) {
      const record = enqueue.call(this, partition, input);
      if (input.command.content.text.includes('orchestration recovery task')) {
        this.update({ ...record, state: 'failed', error: 'E2E definite preparation failure' });
      }
      return record;
    };
  }, resolve('dist/main/session-local-store.js'));
  for (const mode of ['swarm', 'graph']) {
    const original = `/${mode} orchestration recovery task`;
    await page.locator(COMPOSER_INPUT).fill(original);
    await awaitSendReady(page);
    await page.locator(COMPOSER_INPUT).press('Enter');
    await expect(page.getByText('消息未发送', { exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: '编辑后重发', exact: true }).click();
    await expect(page.locator(COMPOSER_INPUT)).toHaveText(original);
    await page.locator(COMPOSER_INPUT).fill(`${original} edited`);
    await awaitSendReady(page);
    await page.locator(COMPOSER_INPUT).press('Enter');
    await expect(page.getByText('消息未发送', { exact: true })).toHaveCount(2);
    // Both sends are deliberately failed before model execution. Inspect the
    // durable intent to verify what the real slash-command path submitted.
    const commands = await app.evaluate(() => {
      const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
      const { DatabaseSync } = require('node:sqlite');
      const { app } = require('electron');
      const db = new DatabaseSync(require('node:path').join(app.getPath('userData'), 'session-experience.sqlite'), { readOnly: true });
      try { return db.prepare('SELECT payload FROM outbox').all().map((row) => JSON.parse(row.payload).intent.command); }
      finally { db.close(); }
    });
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.turnOrchestration)).toEqual([
      { mode, source: 'slash_command' }, { mode, source: 'slash_command' },
    ]);
    expect(new Set(commands.map((command) => command.messageId)).size).toBe(2);
    expect(commands.map((command) => command.content.text).sort()).toEqual([
      'orchestration recovery task', 'orchestration recovery task edited',
    ]);
    for (const message of await page.evaluate((id) => window.maka.sessionLocal.listMessages(id), sessionId)) {
      await page.evaluate(({ id, messageId }) => window.maka.sessionLocal.cancelMessage(id, messageId), { id: sessionId, messageId: message.messageId });
    }
    // Normal UI deletion retires the renderer projection as well.
    await page.reload();
    await ensureSidebarExpanded(page);
    await page.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  }
});

test('durable cancellation proof survives a real Host restart after local cleanup was missed', async ({ sessionLocalWindow }) => {
  const { page, app } = sessionLocalWindow;
  await page.locator(COMPOSER_INPUT).fill('__e2e_hold_open__');
  await awaitSendReady(page);
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText('Fake backend waiting for the test to stop the Turn.', { exact: true })).toBeVisible();
  await ensureSidebarExpanded(page);
  const sessionId = (await page.locator('[data-session-id]:has([aria-current="page"])').getAttribute('data-session-id'))!;
  await page.locator(COMPOSER_INPUT).fill('cancelled across Host restart');
  await page.locator(COMPOSER_INPUT).press('Enter');
  await expect(page.getByText('已排队，等待下一轮回复', { exact: true })).toBeVisible();
  const before = await app.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { DesktopSessionLocalService } = require(require('node:path').resolve('dist/main/session-local-service.js'));
    // Model a disconnected/crashed client that misses local cleanup after Host commit.
    DesktopSessionLocalService.prototype.retireRetractedMessages = () => {};
    DesktopSessionLocalService.prototype.retireCancelledMessages = () => {};
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(require('node:path').join(require('electron').app.getPath('userData'), 'session-experience.sqlite'), { readOnly: true });
    try {
      return db.prepare('SELECT payload FROM outbox').all().map((row) => JSON.parse(row.payload))
        .find((record) => record.intent.command.content.text === 'cancelled across Host restart');
    } finally { db.close(); }
  });
  expect(before.intent.originHostEpoch).toBeTruthy();
  await page.locator(COMPOSER_INPUT).press('Escape');
  await expect(page.getByText('已中断', { exact: true })).toBeVisible();
  expect(await page.evaluate(({ sessionId, messageId }) =>
    window.maka.sessions.queryCancelledMessages(sessionId, [messageId]),
    { sessionId, messageId: before.messageId },
  )).toEqual({ cancelledMessageIds: [before.messageId] });
  expect((await page.evaluate((id) => window.maka.sessionLocal.listMessages(id), sessionId))
    .some((message) => message.messageId === before.messageId)).toBe(true);

  let currentApp: ElectronApplication;
  const restarted = await sessionLocalWindow.restart(async (launched) => {
    currentApp = launched;
    await launched.evaluate(() => {
      const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
      const { DesktopRuntimeHostClient } = require(require('node:path').resolve('dist/main/runtime-host-client.js'));
      const query = DesktopRuntimeHostClient.prototype.queryMessages;
      DesktopRuntimeHostClient.prototype.queryMessages = function (input) {
        globalThis.__e2eCancellationEpoch = this.hostEpoch;
        return query.call(this, input);
      };
    });
  });
  await ensureSidebarExpanded(restarted);
  await restarted.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  expect(await restarted.evaluate(({ sessionId, messageId }) =>
    window.maka.sessions.queryCancelledMessages(sessionId, [messageId]),
    { sessionId, messageId: before.messageId },
  )).toEqual({ cancelledMessageIds: [before.messageId] });
  const currentEpoch = await currentApp!.evaluate(() => globalThis.__e2eCancellationEpoch);
  expect(currentEpoch).toBeTruthy();
  expect(currentEpoch).not.toBe(before.intent.originHostEpoch);
  await expect.poll(() => restarted.evaluate(async ({ sessionId, messageId }) =>
    (await window.maka.sessionLocal.listMessages(sessionId)).some((message) => message.messageId === messageId),
    { sessionId, messageId: before.messageId },
  )).toBe(false);
  await makeHostUnavailable(currentApp!);
  await restarted.reload();
  await ensureSidebarExpanded(restarted);
  await restarted.locator(`[data-session-id=${JSON.stringify(sessionId)}]`).click();
  await expect(restarted.getByText('cancelled across Host restart', { exact: true })).toHaveCount(0);
});

async function makeHostUnavailable(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { resolve } = require('node:path');
    const { DesktopRuntimeHostClient } = require(resolve('dist/main/runtime-host-client.js'));
    for (const method of ['queryMessages', 'openSession', 'listSessions', 'getSession']) {
      DesktopRuntimeHostClient.prototype[method] = async () => { throw new Error('E2E Host offline'); };
    }
    const { RuntimeHostSessionObserver } = require(resolve('dist/main/runtime-host-session-observer.js'));
    for (const method of ['observe', 'openTranscript', 'snapshot']) {
      RuntimeHostSessionObserver.prototype[method] = async () => { throw new Error('E2E Host offline'); };
    }
    const { DesktopSessionLocalService } = require(resolve('dist/main/session-local-service.js'));
    const catalog = DesktopSessionLocalService.prototype.catalog;
    const disconnected = new WeakSet();
    DesktopSessionLocalService.prototype.catalog = function () {
      if (!disconnected.has(this)) {
        disconnected.add(this);
        const targets = this.deps.targets;
        this.deps.targets = () => targets().map((target) => ({ ...target, client: undefined, submit: undefined }));
      }
      return catalog.call(this);
    };
  });
}
