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

import { join } from 'node:path';
import type { DailyReviewArchive } from '@maka/core/daily-review';
import type { E2eFixtureScenario } from '@maka/core/e2e-fixture';
import type {
  ConnectionCatalogEntryDraft,
  ConnectionCatalogSnapshot,
  ConnectionModel,
} from '@maka/core/runtime-policy';
import { createDefaultSettings } from '@maka/core/settings';
import { openInteractiveDailyReviewAuthorityForWrite } from '@maka/storage/daily-review-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { openInteractiveScheduledTaskStoreForWrite } from '@maka/storage/scheduled-task-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { writeJson } from './seed-helpers.js';

export async function writeSettings(
  workspaceRoot: string,
  scenario?: E2eFixtureScenario,
): Promise<void> {
  // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v2 (kenji `08be08d8` + WAWQAQ
  // `1886c41b`): the fixture previously seeded a placeholder
  // Chinese personal name for deterministic rendering, but a real
  // user reading the chat surface can't tell who that placeholder
  // is. Worse, if a demo workspace was ever opened on top of a
  // real user's workspace, the placeholder would persist and
  // confuse them about who set it.
  //
  // Phase 3 fixup v2 leaves `displayName` empty so screenshots and
  // Settings match a new, unconfigured user. Settings test
  // (`e2e-fixture.test.ts`) asserts the empty-string value
  // so a future patch that re-adds a demo name lands as an explicit
  // copy decision, not silent drift.
  const settings = createDefaultSettings();
  settings.personalization.displayName = '';
  settings.appearance.theme = 'auto';
  // Settings → 使用统计: the seeded traffic uses the fixed e2e-fixture clock,
  // which sits outside the real-time 24h/7天/30天 windows the store derives
  // from Date.now(). Default the usage view to 全部 + details-on so the
  // capture shows the populated request log and stats tables deterministically.
  if (scenario === 'settings-usage') {
    settings.usage.range = 'all';
    settings.usage.showDetails = true;
  }
  await writeJson(join(workspaceRoot, 'settings.json'), settings);
}

const ZAI_FIXTURE_MODELS: readonly ConnectionModel[] = [
  model('glm-4.5', { functionCalling: true }, 128_000),
  model('glm-4.5-air', { functionCalling: true }, 128_000),
  model('glm-4.6', { reasoning: true, functionCalling: true }, 200_000),
  model('glm-4.7', { reasoning: true, functionCalling: true }, 200_000),
  model('glm-5', { reasoning: true, functionCalling: true }, 200_000),
  model('glm-5-turbo', { reasoning: true, functionCalling: true }, 200_000),
  model('glm-5.1', { vision: true, reasoning: true, functionCalling: true }, 1_000_000),
];

export async function writeConnections(
  workspaceRoot: string,
  now: number,
  scenario: E2eFixtureScenario,
): Promise<void> {
  const zaiLive: ConnectionCatalogEntryDraft = {
    slug: 'zai-live',
    name: 'Z.ai Live Fixture',
    providerType: 'zai-coding-plan',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    enabled: true,
    enabledModelIds: ZAI_FIXTURE_MODELS.map((item) => item.id),
  };
  const noModels: ConnectionCatalogEntryDraft = {
    slug: 'no-models',
    name: 'No Models Fixture',
    providerType: 'openai-compatible',
    baseUrl: 'https://empty.example.test/v1',
    enabled: true,
    enabledModelIds: [],
  };
  const drafts = scenario === 'settings-models' ? [noModels, zaiLive] : [zaiLive, noModels];
  const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new Error('Unable to acquire the connection catalog fixture root');
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    let revision = 0;
    let defaultConnectionId: string | undefined;
    for (const draft of drafts) {
      const created = await stores.connectionCatalog.create({
        expectedCatalogRevision: revision,
        connection: draft,
      });
      if (created.kind !== 'committed') {
        throw new Error(`Failed to seed ${draft.slug}: ${created.kind}`);
      }
      revision = created.snapshot.revision;
      const connection = findFixtureConnection(created.snapshot, draft.slug);
      if (draft.slug === 'zai-live' || scenario === 'settings-models') {
        const credential = await stores.credentialVault.set({
          locator: {
            scope: 'connection',
            connectionId: connection.connectionId,
            kind: 'api_key',
          },
          expected: null,
          secret: `fixture-key-${draft.slug}`,
        });
        if (credential.kind !== 'committed') {
          throw new Error(`Failed to seed ${draft.slug} credential: ${credential.kind}`);
        }
      }
      if (draft.slug !== 'zai-live') continue;

      defaultConnectionId = connection.connectionId;
      const modelFetch = await stores.operations.beginModelFetch(connection.connectionId);
      if (modelFetch.kind !== 'ready') {
        throw new Error(`Failed to start the zai-live model fixture: ${modelFetch.kind}`);
      }
      const modelInventory = await stores.operations.completeModelFetch(modelFetch.ticket, {
        models: ZAI_FIXTURE_MODELS,
        source: 'fetched',
        fetchedAt: now - 5 * 60_000,
      });
      if (modelInventory.kind !== 'committed') {
        throw new Error(`Failed to seed the zai-live model fixture: ${modelInventory.kind}`);
      }
      revision = modelInventory.snapshot.revision;

      const connectionTest = await stores.operations.beginConnectionTest(
        connection.connectionId,
        'glm-5.1',
      );
      if (connectionTest.kind !== 'ready') {
        throw new Error(`Failed to start the zai-live test fixture: ${connectionTest.kind}`);
      }
      const tested = await stores.operations.completeConnectionTest(connectionTest.ticket, {
        status: 'verified',
        checkedAt: new Date(now - 4 * 60_000).toISOString(),
      });
      if (tested.kind !== 'committed') {
        throw new Error(`Failed to seed the zai-live test fixture: ${tested.kind}`);
      }
      revision = tested.snapshot.revision;
    }
    if (!defaultConnectionId) {
      throw new Error('Failed to resolve the zai-live fixture connection id');
    }
    const defaulted = await stores.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: revision,
      target: { connectionId: defaultConnectionId, modelId: 'glm-5.1' },
    });
    if (defaulted.kind !== 'committed') {
      throw new Error(`Failed to set the fixture default target: ${defaulted.kind}`);
    }
  } finally {
    await owner.close();
  }
}

function findFixtureConnection(snapshot: ConnectionCatalogSnapshot, slug: string) {
  const connection = snapshot.connections.find((item) => item.slug === slug);
  if (!connection) throw new Error(`Committed fixture connection is missing: ${slug}`);
  return connection;
}

function model(
  id: string,
  capabilities: NonNullable<ConnectionModel['capabilities']>,
  contextWindow: number,
): ConnectionModel {
  return { id, capabilities, contextWindow };
}

export async function writeScheduledTasks(workspaceRoot: string, now: number): Promise<void> {
  const scheduledRunAt = Date.UTC(2026, 11, 18, 3, 0, 0);
  const pausedRunAt = Date.UTC(2026, 11, 20, 3, 0, 0);
  // The panel's default 创建时间倒序 sort keys on `createdAt` and only falls
  // back to a status/next-run comparator on ties. Four back-to-back
  // `create()` calls land in the same millisecond, so every task tied
  // and the fallback decided the order — which made any position-based
  // assertion in `scheduled-tasks.spec.ts` vary between runs. Seed one
  // explicit minute apart, oldest first, so 创建时间倒序 has a single answer.
  const createdAt = (index: number): number => now - (4 - index) * 60_000;
  const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new Error('Unable to acquire the ScheduledTask fixture root');
  const store = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
  const create = (
    title: string,
    intentBody: string,
    schedule: Record<string, unknown>,
    at: number,
  ) =>
    store.create(
      {
        title,
        intentBody,
        schedule,
        effect: { kind: 'notify', channel: 'local' },
        createdBy: { kind: 'user' },
      },
      at,
    );
  try {
    await create(
      '同步项目风险',
      '提醒我整理 Sidebar gate、搜索接入和计划任务剩余风险。',
      { kind: 'once', runAt: scheduledRunAt },
      createdAt(0),
    );
    const paused = await create(
      '暂停的发布检查',
      '用户可以先暂停提醒，恢复后继续按原时间触发。',
      { kind: 'once', runAt: pausedRunAt },
      createdAt(1),
    );
    await store.pause(paused.id, createdAt(1) + 1);
    const weekly = await create(
      '每周竞品动态追踪',
      '汇总同类 AI 工具的近期产品变化，提醒我复盘可对标的交互。',
      { kind: 'cron', startAt: scheduledRunAt, expression: '0 10 * * 1' },
      createdAt(2),
    );
    const weeklyClaim = await store.claimNow(weekly.id, scheduledRunAt);
    await store.settleFire(weeklyClaim.id, {
      at: scheduledRunAt,
      outcome: 'ok',
      message: '已生成本周竞品动态摘要',
    });
    const completed = await create(
      '已触发的本地提醒',
      '',
      { kind: 'once', runAt: scheduledRunAt },
      createdAt(3),
    );
    const completedClaim = await store.claimNow(completed.id, scheduledRunAt);
    await store.settleFire(completedClaim.id, {
      at: scheduledRunAt,
      outcome: 'ok',
      message: '定时任务已触发',
    });
    // The list's search / sort / filter controls only appear at eight
    // tasks, and they are the widest thing the page header carries — the
    // narrow-window geometry test has nothing to measure below that count.
    // These four carry no state any other test reads. They are seeded OLDER
    // than the four above so 创建时间倒序 keeps those four in the first four
    // rows, which is what the ordering test above pins.
    for (const [index, title] of [
      '每日站会前汇总阻塞项',
      '每月依赖许可证审计',
      '季度收尾清点未归档任务',
      '发布前跑一轮回归',
    ].entries()) {
      await create(
        title,
        '',
        { kind: 'once', runAt: scheduledRunAt + (index + 1) * 86_400_000 },
        now - (8 - index) * 60_000,
      );
    }
  } finally {
    store.close();
    await owner.close();
  }
}

export async function writeDailyReviewArchives(workspaceRoot: string, now: number): Promise<void> {
  const dayFromMs = new Date(2026, 4, 21).getTime();
  const dayToMs = new Date(2026, 4, 22).getTime();
  const daily: DailyReviewArchive = {
    id: '2026-05-21-1d',
    day: { fromMs: dayFromMs, toMs: dayToMs },
    range: 1,
    status: 'ok',
    generatedAt: now - 10 * 60_000,
    trigger: 'manual',
    modelKey: 'zai-live::glm-4.5',
    totals: {
      sessionCount: 8,
      requestCount: 34,
      totalTokens: 128_640,
      costUsd: 1.82,
      errorCount: 1,
    },
    sections: {
      summary: '今天主要围绕 Maka 桌面端的侧边栏、权限中心和每日回顾展开，重点是把入口、报告保存和设置项接到真实运行链路。',
      gaps: '权限中心按钮已经接入系统设置跳转；每日回顾外部通知仍缺少报告自动推送运行时，需要保持不可用状态而不是展示假开关。',
      usage: '模型请求集中在 UI 逆向与合约验证，工具调用以文件检索、构建和截图 smoke 为主。',
      code: '建议继续收敛 Settings 与模块页的 shared page shell，减少同类 surface 在 styles.css 里的重复规则。',
    },
  };
  const deep: DailyReviewArchive = {
    ...daily,
    id: '2026-05-15-7d',
    day: { fromMs: new Date(2026, 4, 15).getTime(), toMs: dayToMs },
    range: 7,
    generatedAt: now - 5 * 60_000,
    trigger: 'cron',
    totals: {
      ...daily.totals,
      sessionCount: 12,
      requestCount: 58,
      totalTokens: 211_300,
      costUsd: 3.94,
      errorCount: 1,
    },
    sections: {
      summary: '深度分析覆盖最近一轮 Maka UI 打磨：参考布局学习、权限中心重画、Daily Review 从聚合面板走向可保存报告。',
      gaps: '第一性原理层面需要把“模块页 shell / Settings row / 状态 pill / 操作按钮”抽成真实组件，否则后续仍会在 CSS 中继续堆叠局部规则。',
      usage: '高频动作是读取源码、运行 contract、构建 renderer、生成 e2e-fixture 截图。失败成本主要来自多处页面壳层行为不统一。',
      code: '下一步优先建立模块页 PageShell、SettingsActionRow 和 StatusPill primitives，再迁移 Daily Review、权限中心、计划任务和技能页。',
    },
  };
  const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new Error('Unable to acquire the Daily Review fixture root');
  try {
    const store = await openInteractiveDailyReviewAuthorityForWrite(owner.lease);
    try {
      await store.publishArchive(daily, 180);
      await store.publishArchive(deep, 180);
    } finally {
      store.close();
    }
  } finally {
    await owner.close();
  }
}
