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

import { FAKE_HOLD_OPEN_PROMPT, FAKE_WAIT_FOR_STEERING_PROMPT } from '@maka/runtime/test-only/fake-backend';
import { connectExistingRuntimeHost } from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import type { ElectronApplication } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseDesktopSessionKey } from '../src/shared/runtime-host-identity';
import { awaitSendReady, COMPOSER_INPUT, expect, test, withE2eWindow } from './fixtures';

type ReconnectFixture = {
  closeConnection(): Promise<void>;
  release(): void;
  waiting: boolean;
  reseeded: boolean;
};
type ReconnectGlobal = typeof globalThis & { __makaSideChatReconnect?: ReconnectFixture };

async function armConnectionGap(app: ElectronApplication): Promise<void> {
  // Fault only the transport in this disposable main process. Keep the Host,
  // renderer, stored messages and observation recovery path running unchanged.
  await app.evaluate(() => {
    const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/`);
    const { DesktopRuntimeHostClient } = require('./dist/main/runtime-host-client.js');
    const { RuntimeHostSessionObservationRegistry } = require('./dist/main/runtime-host-session-observation-registry.js');
    const queryMessageExecutions = DesktopRuntimeHostClient.prototype.queryMessageExecutions;
    const attach = RuntimeHostSessionObservationRegistry.prototype.attach;
    let client: { connection: { close(): Promise<void> } } | undefined;
    let release!: () => void;
    const gap = new Promise<void>((resolve) => { release = resolve; });
    const state: ReconnectFixture = {
      async closeConnection() {
        if (!client) throw new Error('Side Chat fixture did not capture the Desktop connection');
        await client.connection.close();
      },
      release,
      waiting: false,
      reseeded: false,
    };
    DesktopRuntimeHostClient.prototype.queryMessageExecutions = function (...args: unknown[]) {
      client = this;
      DesktopRuntimeHostClient.prototype.queryMessageExecutions = queryMessageExecutions;
      return queryMessageExecutions.apply(this, args);
    };
    RuntimeHostSessionObservationRegistry.prototype.attach = async function (...args: unknown[]) {
      state.waiting = true;
      await gap;
      RuntimeHostSessionObservationRegistry.prototype.attach = attach;
      const result = await attach.apply(this, args);
      state.reseeded = true;
      return result;
    };
    (globalThis as ReconnectGlobal).__makaSideChatReconnect = state;
  });
}

// The real main-window capture listener previously swallowed queue drops, and
// the restored main/preload observation left completed entries in this panel.
// Component/Host tests omit those Electron owners; this one window verifies
// their wiring while the existing hook/projector suites cover state orderings.
test('Side Chat follow-ups survive queue actions, Host handoffs and reconnect', async ({}, testInfo) => {
  await withE2eWindow({
    seed: true,
    readinessSelector: COMPOSER_INPUT,
    locale: 'zh-CN',
    showWindow: true,
    tracePath: testInfo.outputPath('trace.zip'),
  }, async (page, { app, userDataDir }) => {
    const composer = page.locator(COMPOSER_INPUT);
    await composer.fill('side conversation acceptance source');
    await awaitSendReady(page);
    await composer.press('Enter');
    await expect(page.getByRole('button', { name: '重新生成' })).toHaveCount(1, { timeout: 20_000 });
    const originalSessionIds = await page.evaluate(async () =>
      (await window.maka.sessions.list()).map((session) => session.id));
    await page.getByRole('button', { name: '展开任务工作栏' }).click();
    await page.getByRole('button', { name: /侧边对话.*在不打断主任务的情况下追问和只读探索/ }).click();
    const companion = page.locator('.maka-quote-companion');
    const sideComposer = companion.locator(COMPOSER_INPUT);
    await sideComposer.fill(FAKE_HOLD_OPEN_PROMPT);
    await sideComposer.press('Enter');
    await expect(companion).toContainText('Fake backend waiting');
    const forkId = await page.evaluate(async (existingIds) => {
      const created = (await window.maka.sessions.list()).filter((session) => !existingIds.includes(session.id));
      if (created.length !== 1) throw new Error(`Expected one Side Chat fork, found ${created.length}`);
      return created[0]!.id;
    }, originalSessionIds);
    const queued = companion.locator('.maka-composer-queue');
    for (const text of ['first follow-up', 'second follow-up', 'retract this follow-up']) {
      await sideComposer.fill(text);
      await sideComposer.press('Enter');
      await expect(queued).toContainText(text);
    }
    await expect(queued.locator('.maka-composer-queue-text')).toHaveText([
      'first follow-up', 'second follow-up', 'retract this follow-up',
    ]);
    await queued.getByRole('button', { name: '编辑', exact: true }).first().click();
    const edit = queued.getByRole('textbox', { name: '编辑', exact: true });
    await edit.fill('edited first follow-up');
    await edit.press('Enter');
    await expect(queued.locator('.maka-composer-queue-text').first()).toHaveText('edited first follow-up');
    const grips = queued.locator('[draggable="true"]');
    await grips.nth(1).dragTo(grips.nth(0));
    await expect(queued.locator('.maka-composer-queue-text')).toHaveText([
      'second follow-up', 'edited first follow-up', 'retract this follow-up',
    ]);
    await queued.getByRole('button', { name: '删除', exact: true }).nth(2).click();
    await expect(queued).not.toContainText('retract this follow-up');
    await expect(companion.getByRole('button', { name: '停止', exact: true })).toBeVisible();

    await sideComposer.fill('steer the current response');
    await sideComposer.press('Shift+Enter');
    await expect(companion).toContainText('Acknowledged steering: steer the current response');
    await expect(queued.locator('.maka-composer-queue-text')).toHaveText([
      'second follow-up', 'edited first follow-up',
    ]);
    await queued.getByRole('button', { name: '调整方向', exact: true }).first().click();
    await expect(companion.locator('.maka-steering-message').last()).toContainText('second follow-up');
    await expect(queued.locator('.maka-composer-queue-text')).toHaveText(['edited first follow-up']);
    await queued.getByRole('button', { name: '删除', exact: true }).click();
    await expect(queued).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('side-chat-steering.png'), fullPage: true });
    await companion.getByRole('button', { name: '停止', exact: true }).click();
    await expect(companion.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: 20_000 });
    // The held-open fixture's pipe-separated acknowledgment is an unfinished
    // Markdown table candidate until Stop flushes the final assistant message.
    await expect(companion).toContainText('steer the current response | second follow-up');

    // Hold a second Turn before its first token, queue two successors, then
    // release it by steering. All three replies must survive the Host handoffs.
    await sideComposer.fill(FAKE_WAIT_FOR_STEERING_PROMPT);
    await sideComposer.press('Enter');
    await expect(companion.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    for (const text of ['successor one', 'successor two']) {
      await sideComposer.fill(text);
      await sideComposer.press('Enter');
      await expect(queued).toContainText(text);
    }
    await page.screenshot({ path: testInfo.outputPath('side-chat-queue.png'), fullPage: true });
    await sideComposer.fill('release the held response');
    await sideComposer.press('Shift+Enter');
    await expect(companion).toContainText('Acknowledged steering: release the held response');
    await expect(companion).toContainText('Fake backend received: successor one', { timeout: 20_000 });
    await expect(companion).toContainText('Fake backend received: successor two', { timeout: 20_000 });
    await expect(companion.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: 20_000 });
    await expect(queued).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('side-chat-settled.png'), fullPage: true });

    await sideComposer.fill(FAKE_WAIT_FOR_STEERING_PROMPT);
    await sideComposer.press('Enter');
    await expect(companion.getByRole('button', { name: '停止', exact: true })).toBeVisible();
    for (const text of ['reconnected successor one', 'reconnected successor two']) {
      await sideComposer.fill(text);
      await sideComposer.press('Enter');
      await expect(queued).toContainText(text);
    }
    await armConnectionGap(app);
    // Capture the actual Desktop client before closing its transport.
    await page.evaluate((id) => window.maka.sessions.queryMessageExecutions(id, ['e2e-connection-probe']), forkId);
    const hostSessionId = parseDesktopSessionKey(forkId).sessionId;
    const connection = await connectExistingRuntimeHost({
      rootPath: join(userDataDir, 'workspaces', 'default'),
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    });
    expect(connection.kind).toBe('connected');
    if (connection.kind !== 'connected') throw new Error('Acceptance client could not connect to Host');
    try {
      await app.evaluate(() => (globalThis as ReconnectGlobal).__makaSideChatReconnect!.closeConnection());
      await expect.poll(() => app.evaluate(() => (globalThis as ReconnectGlobal).__makaSideChatReconnect!.waiting)).toBe(true);
      await connection.connection.request('turn.message.submit', {
        originHostEpoch: connection.connection.hostEpoch,
        sessionId: hostSessionId,
        messageId: randomUUID(),
        content: { text: 'release while Desktop is disconnected' },
        placement: 'current_turn',
      });
      await expect.poll(async () => {
        const turns = await connection.connection.request('session.turns.query', {
          sessionId: hostSessionId, position: 0, throughSequence: null, maxContributions: 128,
        });
        return turns.contributions.filter((turn) =>
          turn.userPromptPreview?.startsWith('reconnected successor') && turn.latestState?.message.status === 'completed').length;
      }, { timeout: 20_000 }).toBe(2);
      await expect(queued.locator('.maka-composer-queue-text')).toHaveText([
        'reconnected successor one', 'reconnected successor two',
      ]);
    } finally {
      await app.evaluate(() => (globalThis as ReconnectGlobal).__makaSideChatReconnect!.release());
      await connection.connection.close();
    }
    await expect.poll(() => app.evaluate(() => (globalThis as ReconnectGlobal).__makaSideChatReconnect!.reseeded)).toBe(true);
    await expect(companion).toContainText('Fake backend received: reconnected successor one', { timeout: 20_000 });
    await expect(companion).toContainText('Fake backend received: reconnected successor two');
    await expect(queued).toHaveCount(0);
    await expect(companion.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('side-chat-reconnected.png'), fullPage: true });
  });
});
