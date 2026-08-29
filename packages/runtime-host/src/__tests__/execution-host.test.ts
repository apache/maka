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
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TOOL_BOUNDARY_PROTOCOL_V1 } from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { MessageContent } from '@maka/core/events';
import type { ConnectionCatalogEntry } from '@maka/core/runtime-policy';
import {
  decodeStoredMessage as decodePersistedStoredMessage,
  type StoredMessage,
} from '@maka/core/session';
import { markPersisted } from '@maka/core/persisted-value';
import type { Task } from '@maka/core/task-ledger';
import type { ScheduledTask } from '@maka/core/scheduled-task';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { buildTaskLedgerTools } from '@maka/runtime/task-ledger-tools';
import {
  buildRecoveredTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitTerminalRunWithRuntimeFact,
} from '@maka/runtime/terminal-run-commit';
import {
  FAKE_ASK_SANDBOX_BOUNDARY_PROMPT,
  FAKE_ASK_USER_QUESTION_PROMPT,
  FAKE_WAIT_FOR_STEERING_PROMPT,
} from '@maka/runtime/test-only/fake-backend';
import { type MakaTool, type MakaToolContext } from '@maka/runtime/tool-runtime';
import {
  openInteractiveExecutionStoresForRead,
  openInteractiveExecutionStoresForWrite,
} from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { openInteractiveScheduledTaskStoreForWrite } from '@maka/storage/scheduled-task-store';
import {
  resolveRootControlNamespace,
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  tryAcquireInteractiveRootReader,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { openInteractiveTaskLedgerStoreForWrite } from '@maka/storage/task-ledger-authority';
import {
  connectRuntimeHost,
  RuntimeHostOperationError,
  RuntimeHostSubscriptionError,
  type RuntimeHostConnection,
  type RuntimeHostSessionSubscription,
} from '../client/index.js';
import {
  decodeHostFrame,
  RUNTIME_HOST_PROTOCOL_VERSION,
  TASK_LEDGER_PAGE_MAX_ITEMS,
  type ConnectionCatalogQueryResult,
  type InteractionPendingSnapshot,
  type SubscriptionFrame,
  type TaskLedgerQueryResult,
  type TaskLedgerRevision,
  type TurnMessageSubmitInput,
  type TurnSnapshot,
} from '../protocol/index.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { HostTaskLedgerCoordinator } from '../server/task-ledger-coordinator.js';
import { FramedTransport } from '../transport/framed-transport.js';

import {
  CONNECTION_EFFECT_MODEL_IDS,
  type ExecutionFixture,
  PROCESS_TIMEOUT_MS,
  SubscriptionProbe,
  assertJsonLines,
  attachment,
  connectClient,
  requireStartedTurn,
  operationError,
  quotedContent,
  sendStartWithoutReadingResponse,
  startConnectionEffectProvider,
  userRuntimeContent,
  waitForDurableMessageConflict,
  waitForPendingInteraction,
  waitForRunningTurn,
  waitForTerminalTurn,
  waitForTurn,
  withExecutionRoot,
  withTimeout,
} from './fixtures/execution-host-suite.js';

const decodeStoredMessage = (value: unknown): StoredMessage =>
  decodePersistedStoredMessage(markPersisted<StoredMessage>(value));

test('production Host resumes a Session through the ScheduledTask authority', {
  timeout: 30_000,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const desktop = await connectClient(fixture.root);
    const tui = await connectClient(fixture.root);
    try {
      const heartbeat = await desktop.request('scheduled-task.mutate', {
        kind: 'create',
        input: {
          title: 'session resume execution proof',
          intentBody: 'Complete the scheduled execution proof.',
          schedule: { kind: 'once', runAt: Date.now() + 5_000 },
          effect: { kind: 'session_resume', sessionId: fixture.sessionId },
        },
      });
      assert.equal(heartbeat.kind, 'task');
      if (heartbeat.kind !== 'task') {
        return;
      }

      const observedHeartbeat = await waitForScheduledTaskCompletion(tui, heartbeat.task.id);
      assert.ok(observedHeartbeat.runs[0]?.runId);
      assert.equal(observedHeartbeat.lastError, null);

      const deletedHeartbeat = await tui.request('scheduled-task.mutate', {
        kind: 'delete',
        taskId: heartbeat.task.id,
      });
      assert.equal(deletedHeartbeat.kind, 'deleted');
    } finally {
      await Promise.allSettled([desktop.close(), tui.close()]);
      await fixture.stopHost(host);
    }
  });
});

test('production Host migrates Daily Review into ScheduledTask Session and Artifact authorities', {
  timeout: 30_000,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const archiveDay = new Date();
    archiveDay.setHours(0, 0, 0, 0);
    archiveDay.setDate(archiveDay.getDate() - 2);
    const archiveDayEnd = new Date(archiveDay);
    archiveDayEnd.setDate(archiveDayEnd.getDate() + 1);
    const archiveDate = `${archiveDay.getFullYear()}-${String(archiveDay.getMonth() + 1).padStart(2, '0')}-${String(archiveDay.getDate()).padStart(2, '0')}`;
    const archive = {
      id: `${archiveDate}-1d`,
      day: { fromMs: archiveDay.getTime(), toMs: archiveDayEnd.getTime() },
      range: 1,
      status: 'ok',
      generatedAt: archiveDayEnd.getTime() + 1,
      trigger: 'cron',
      modelKey: '',
      sections: { summary: 'A migrated report.' },
      totals: {
        sessionCount: 2,
        requestCount: 3,
        totalTokens: 4,
        costUsd: 0.01,
        errorCount: 0,
      },
    } as const;
    const database = new DatabaseSync(join(fixture.root, 'runtime.sqlite'));
    database.exec(`
      CREATE TABLE workflow_daily_review_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        config_json TEXT NOT NULL
      );
      CREATE TABLE workflow_daily_review_authority_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
      CREATE TABLE workflow_daily_review_archives (
        archive_id TEXT PRIMARY KEY,
        generated_at INTEGER NOT NULL,
        day_from_ms INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX workflow_daily_review_archives_order
        ON workflow_daily_review_archives(generated_at DESC, day_from_ms DESC, archive_id);
    `);
    database
      .prepare('INSERT INTO workflow_daily_review_state(singleton, config_json) VALUES (1, ?)')
      .run(
        JSON.stringify({
          enabled: true,
          executeTime: '00:00',
          modelKey: 'fake::fake-model',
        }),
      );
    database
      .prepare(
        `INSERT INTO workflow_daily_review_archives(
          archive_id, generated_at, day_from_ms, record_json
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(archive.id, archive.generatedAt, archive.day.fromMs, JSON.stringify(archive));
    database.close();

    const disabledPolicyOwner = await tryAcquireInteractiveRootOwner(fixture.capability);
    assert.ok(disabledPolicyOwner);
    if (!disabledPolicyOwner) return;
    const disabledPolicy = await openInteractiveRuntimePolicyStoresForWrite(
      disabledPolicyOwner.lease,
    );
    const unsafeDefaults = await disabledPolicy.runtimePolicy.getSnapshot();
    const unsafeDefaultsResult = await disabledPolicy.runtimePolicy.mutate({
      expectedRevision: unsafeDefaults.revision,
      operation: {
        kind: 'set_chat_defaults',
        value: { permissionMode: 'bypass' },
      },
    });
    assert.equal(unsafeDefaultsResult.kind, 'committed');
    const disabledCatalog = await disabledPolicy.connectionCatalog.getSnapshot();
    const disabledConnectionResult = await disabledPolicy.connectionCatalog.create({
      expectedCatalogRevision: disabledCatalog.revision,
      connection: {
        slug: 'fake',
        name: 'Disabled Daily Review fixture',
        providerType: 'moonshot',
        enabled: false,
        enabledModelIds: ['fake-model'],
      },
    });
    assert.equal(disabledConnectionResult.kind, 'committed');
    await disabledPolicyOwner.close();

    const unresolvedHost = await fixture.startHost();
    const unresolvedDesktop = await connectClient(fixture.root);
    try {
      const taskPage = await unresolvedDesktop.request('scheduled-task.query', { kind: 'list' });
      assert.equal(taskPage.kind, 'page');
      if (taskPage.kind !== 'page') return;
      assert.equal(
        taskPage.tasks.some((candidate) => candidate.id === 'system-daily-review'),
        false,
      );
      await assert.rejects(
        unresolvedDesktop.request('artifact.query', {
          kind: 'list_start',
          sessionId: `daily-review-archive-${archive.id}`,
        }),
        /Session was not found/u,
      );
    } finally {
      await unresolvedDesktop.close();
      await fixture.stopHost(unresolvedHost);
    }

    const pending = new DatabaseSync(join(fixture.root, 'runtime.sqlite'), { readOnly: true });
    try {
      assert.equal(
        Boolean(
          pending
            .prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workflow_daily_review_state'",
            )
            .get(),
        ),
        true,
      );
    } finally {
      pending.close();
    }

    const policyOwner = await tryAcquireInteractiveRootOwner(fixture.capability);
    assert.ok(policyOwner);
    if (!policyOwner) return;
    const policy = await openInteractiveRuntimePolicyStoresForWrite(policyOwner.lease);
    const current = await policy.connectionCatalog.getSnapshot();
    const disabledConnection = current.connections.find(({ slug }) => slug === 'fake');
    assert.ok(disabledConnection);
    if (!disabledConnection) return;
    const enabledConnection = await policy.connectionCatalog.update({
      expected: {
        connectionId: disabledConnection.connectionId,
        revision: disabledConnection.revision,
      },
      changes: {
        name: 'Migrated Daily Review fixture',
        enabled: true,
        enabledModelIds: ['fake-model'],
      },
    });
    assert.equal(enabledConnection.kind, 'committed');
    if (enabledConnection.kind !== 'committed') return;
    const connection = enabledConnection.snapshot.connections.find(({ slug }) => slug === 'fake');
    assert.ok(connection);
    if (!connection) return;
    const credential = await policy.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: 'daily-review-migration-test-key',
    });
    assert.equal(credential.kind, 'committed');
    await policyOwner.close();

    const host = await fixture.startHost();
    const desktop = await connectClient(fixture.root);
    try {
      const taskPage = await desktop.request('scheduled-task.query', { kind: 'list' });
      assert.equal(taskPage.kind, 'page');
      if (taskPage.kind !== 'page') return;
      const task = taskPage.tasks.find((candidate) => candidate.id === 'system-daily-review');
      assert.ok(task);
      assert.equal(task?.createdBy.kind, 'system');
      assert.equal(task?.presetId, 'daily-review');
      assert.equal(task?.status, 'active');
      assert.equal(
        task?.effect.kind === 'agent_run' ? task.effect.execution.llmConnectionId : undefined,
        connection.connectionId,
      );
      assert.equal(
        task?.effect.kind === 'agent_run' ? task.effect.execution.permissionMode : undefined,
        'ask',
      );
      assert.deepEqual(task?.schedule, {
        kind: 'calendar',
        recurrence: 'daily',
        anchorAt: task?.schedule.kind === 'calendar' ? task.schedule.anchorAt : -1,
        catchUp: 'once',
      });
      if (task?.schedule.kind === 'calendar') {
        const anchor = new Date(task.schedule.anchorAt);
        assert.equal(
          `${anchor.getHours()}:${String(anchor.getMinutes()).padStart(2, '0')}`,
          '0:00',
        );
      }
      assert.equal(task?.fireCount, 1);
      assert.equal(task?.runs.length, 1);
      assert.ok(task?.runs[0]?.sessionId, task?.runs[0]?.message);

      const sessionId = `daily-review-archive-${archive.id}`;
      const session = await desktop.request('session.catalog.query', { kind: 'get', sessionId });
      assert.equal(session.kind, 'session');
      assert.equal(session.session?.id, sessionId);
      assert.ok(session.session && !('kind' in session.session));
      if (!session.session || 'kind' in session.session) return;
      assert.deepEqual(session.session.labels, ['migrated:daily-review']);

      const artifacts = await desktop.request('artifact.query', { kind: 'list_start', sessionId });
      assert.equal(artifacts.kind, 'page');
      if (artifacts.kind !== 'page') return;
      assert.equal(artifacts.artifacts.length, 1);
      const artifact = artifacts.artifacts[0];
      assert.equal(artifact?.id, `daily-review-report-${archive.id}`);
      const report = await desktop.request('artifact.query', {
        kind: 'read_text',
        sessionId,
        artifactId: artifact!.id,
      });
      assert.equal(report.kind, 'text');
      if (report.kind !== 'text' || !report.preview.ok) return;
      assert.match(report.preview.text, /A migrated report\./u);
      assert.match(report.preview.text, new RegExp(`Archive ID: ${archive.id}`, 'u'));
      assert.match(report.preview.text, /Trigger: cron/u);
      assert.match(report.preview.text, /Model: \(default\)/u);
      assert.match(report.preview.text, new RegExp(`Generated at: ${archive.generatedAt}`, 'u'));

      const fired = await desktop.request('scheduled-task.mutate', {
        kind: 'trigger_now',
        taskId: 'system-daily-review',
      });
      assert.equal(fired.kind, 'task');
      if (fired.kind !== 'task') return;
      assert.equal(fired.task.runs.length, 2);
      assert.ok(fired.task.runs[1]?.sessionId);
      assert.ok(fired.task.runs[1]?.runId);
      const runSession = await desktop.request('session.catalog.query', {
        kind: 'get',
        sessionId: fired.task.runs[1]!.sessionId!,
      });
      assert.equal(runSession.kind, 'session');
      assert.ok(
        runSession.session && !('kind' in runSession.session),
        `${fired.task.lastError ?? 'ScheduledTask Session missing'}: ${JSON.stringify(runSession)}`,
      );
      assert.equal(runSession.session?.id, fired.task.runs[1]?.sessionId);
    } finally {
      await desktop.close();
      await fixture.stopHost(host);
    }

    const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
    assert.ok(owner);
    if (!owner) return;
    let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
    try {
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const messages = await stores.sessionStore.readMessagesSnapshot(
        `daily-review-archive-${archive.id}`,
      );
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.type, 'assistant');
      assert.match(messages[0]?.text ?? '', /A migrated report\./u);
    } finally {
      await stores?.sessionStore.close?.();
      await owner.close();
    }

    const retired = new DatabaseSync(join(fixture.root, 'runtime.sqlite'), { readOnly: true });
    try {
      const tables = retired
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'workflow_daily_review_%'",
        )
        .all();
      assert.deepEqual(tables, []);
    } finally {
      retired.close();
    }

    const restartedHost = await fixture.startHost();
    const restartedDesktop = await connectClient(fixture.root);
    try {
      const taskPage = await restartedDesktop.request('scheduled-task.query', { kind: 'list' });
      assert.equal(taskPage.kind, 'page');
      if (taskPage.kind !== 'page') return;
      assert.equal(
        taskPage.tasks.filter((candidate) => candidate.id === 'system-daily-review').length,
        1,
      );
      const artifacts = await restartedDesktop.request('artifact.query', {
        kind: 'list_start',
        sessionId: `daily-review-archive-${archive.id}`,
      });
      assert.equal(artifacts.kind, 'page');
      if (artifacts.kind !== 'page') return;
      assert.equal(artifacts.artifacts.length, 1);
    } finally {
      await restartedDesktop.close();
      await fixture.stopHost(restartedHost);
    }
  });
});

test('production Host retires disabled Daily Review after projecting its reports', {
  timeout: 30_000,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const archive = {
      id: '2026-08-20-1d',
      day: { fromMs: 1_771_132_800_000, toMs: 1_771_219_200_000 },
      range: 1,
      status: 'ok',
      generatedAt: 1_771_219_200_001,
      trigger: 'cron',
      modelKey: '',
      sections: { summary: 'A disabled review report.' },
      totals: {
        sessionCount: 1,
        requestCount: 1,
        totalTokens: 1,
        costUsd: 0,
        errorCount: 0,
      },
    } as const;
    const database = new DatabaseSync(join(fixture.root, 'runtime.sqlite'));
    database.exec(`
      CREATE TABLE workflow_daily_review_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        config_json TEXT NOT NULL
      );
      CREATE TABLE workflow_daily_review_authority_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      );
      CREATE TABLE workflow_daily_review_archives (
        archive_id TEXT PRIMARY KEY,
        generated_at INTEGER NOT NULL,
        day_from_ms INTEGER NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX workflow_daily_review_archives_order
        ON workflow_daily_review_archives(generated_at DESC, day_from_ms DESC, archive_id);
    `);
    database
      .prepare('INSERT INTO workflow_daily_review_state(singleton, config_json) VALUES (1, ?)')
      .run(JSON.stringify({ enabled: false, executeTime: '08:00', modelKey: '' }));
    database
      .prepare(
        `INSERT INTO workflow_daily_review_archives(
          archive_id, generated_at, day_from_ms, record_json
        ) VALUES (?, ?, ?, ?)`,
      )
      .run(archive.id, archive.generatedAt, archive.day.fromMs, JSON.stringify(archive));
    database.close();

    const host = await fixture.startHost();
    const desktop = await connectClient(fixture.root);
    try {
      const taskPage = await desktop.request('scheduled-task.query', { kind: 'list' });
      assert.equal(taskPage.kind, 'page');
      if (taskPage.kind !== 'page') return;
      assert.equal(
        taskPage.tasks.some((candidate) => candidate.id === 'system-daily-review'),
        false,
      );
      const artifacts = await desktop.request('artifact.query', {
        kind: 'list_start',
        sessionId: `daily-review-archive-${archive.id}`,
      });
      assert.equal(artifacts.kind, 'page');
      if (artifacts.kind !== 'page') return;
      assert.equal(artifacts.artifacts.length, 1);
    } finally {
      await desktop.close();
      await fixture.stopHost(host);
    }

    const retired = new DatabaseSync(join(fixture.root, 'runtime.sqlite'), { readOnly: true });
    try {
      const tables = retired
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'workflow_daily_review_%'",
        )
        .all();
      assert.deepEqual(tables, []);
    } finally {
      retired.close();
    }
  });
});

test('production Host binds a legacy Agent ScheduledTask to its canonical Connection', {
  timeout: 30_000,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
    assert.ok(owner);
    if (!owner) return;
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const catalog = await policy.connectionCatalog.getSnapshot();
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: catalog.revision,
      connection: {
        slug: 'legacy-ready',
        name: 'Legacy ready task',
        providerType: 'moonshot',
        enabled: true,
        enabledModelIds: ['legacy-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections.find(({ slug }) => slug === 'legacy-ready');
    assert.ok(connection);
    if (!connection) return;
    assert.equal(
      (
        await policy.credentialVault.set({
          locator: {
            scope: 'connection',
            connectionId: connection.connectionId,
            kind: 'api_key',
          },
          expected: null,
          secret: 'legacy-scheduled-task-key',
        })
      ).kind,
      'committed',
    );
    const scheduledTasks = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
    const task = await scheduledTasks.create({
      title: 'Legacy Agent task',
      intentBody: 'Continue the scheduled work.',
      schedule: { kind: 'interval', everySeconds: 3_600, startAt: Date.now() + 3_600_000 },
      effect: {
        kind: 'agent_run',
        execution: {
          cwd: fixture.root,
          projectId: null,
          llmConnectionId: connection.connectionId,
          llmConnectionSlug: connection.slug,
          model: 'legacy-model',
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        },
      },
      createdBy: { kind: 'user' },
    });
    const unresolvedTask = await scheduledTasks.create({
      title: 'Unresolved legacy Agent task',
      intentBody: 'Wait for a valid Connection.',
      schedule: { kind: 'interval', everySeconds: 3_600, startAt: Date.now() + 3_600_000 },
      effect: {
        kind: 'agent_run',
        execution: {
          cwd: fixture.root,
          projectId: null,
          llmConnectionId: 'removed-connection',
          llmConnectionSlug: 'removed-connection',
          model: 'removed-model',
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
        },
      },
      createdBy: { kind: 'user' },
    });
    scheduledTasks.close();
    await owner.close();

    const database = new DatabaseSync(join(fixture.root, 'runtime.sqlite'));
    database
      .prepare(
        `UPDATE workflow_scheduled_tasks
        SET record_json = json_remove(record_json, '$.effect.execution.llmConnectionId')
        WHERE task_id IN (?, ?)`,
      )
      .run(task.id, unresolvedTask.id);
    database.close();

    const host = await fixture.startHost();
    const desktop = await connectClient(fixture.root);
    try {
      const page = await desktop.request('scheduled-task.query', { kind: 'list' });
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') return;
      const repaired = page.tasks.find((candidate) => candidate.id === task.id);
      assert.equal(
        repaired?.effect.kind === 'agent_run'
          ? repaired.effect.execution.llmConnectionId
          : undefined,
        connection.connectionId,
      );
      assert.equal(
        page.tasks.find((candidate) => candidate.id === unresolvedTask.id)?.status,
        'paused',
      );
    } finally {
      await desktop.close();
      await fixture.stopHost(host);
    }
  });
});

test('production Host starts ScheduledTask Agent runs in an ordinary Session', {
  timeout: 30_000,
}, async () => {
  await withExecutionRoot(async (fixture) => {
    const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
    assert.ok(owner);
    if (!owner) return;
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const current = await policy.connectionCatalog.getSnapshot();
    const createdConnection = await policy.connectionCatalog.create({
      expectedCatalogRevision: current.revision,
      connection: {
        slug: 'fake',
        name: 'ScheduledTask fixture',
        providerType: 'moonshot',
        enabled: true,
        enabledModelIds: ['fake-model'],
      },
    });
    assert.equal(createdConnection.kind, 'committed');
    if (createdConnection.kind !== 'committed') return;
    const connection = createdConnection.snapshot.connections.find(({ slug }) => slug === 'fake');
    assert.ok(connection);
    if (!connection) return;
    const credential = await policy.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: 'scheduled-task-test-key',
    });
    assert.equal(credential.kind, 'committed');
    await owner.close();

    const host = await fixture.startHost();
    const desktop = await connectClient(fixture.root);
    try {
      const created = await desktop.request('scheduled-task.mutate', {
        kind: 'create',
        input: {
          presetId: 'daily-review',
          title: 'scheduled agent-run Session proof',
          intentBody: 'Run through the ordinary Session authority.',
          schedule: { kind: 'once', runAt: Date.now() + 60_000 },
          effect: {
            kind: 'agent_run',
            execution: {
              cwd: fixture.root,
              llmConnectionId: connection.connectionId,
              llmConnectionSlug: 'fake',
              model: 'fake-model',
              permissionMode: 'ask',
              collaborationMode: 'agent',
              orchestrationMode: 'default',
            },
          },
        },
      });
      assert.equal(created.kind, 'task');
      if (created.kind !== 'task') return;

      const fired = await desktop.request('scheduled-task.mutate', {
        kind: 'trigger_now',
        taskId: created.task.id,
      });
      assert.equal(fired.kind, 'task');
      if (fired.kind !== 'task') return;
      assert.equal(fired.task.runs.length, 1);
      const sessionId = fired.task.runs[0]?.sessionId;
      assert.ok(sessionId);
      assert.ok(fired.task.runs[0]?.runId);
      const session = await desktop.request('session.catalog.query', {
        kind: 'get',
        sessionId: sessionId!,
      });
      assert.equal(session.kind, 'session');
      assert.ok(session.session, fired.task.lastError ?? 'ScheduledTask Session was not created');
      assert.ok(session.session && !('kind' in session.session));
      if (!session.session || 'kind' in session.session) return;
      assert.equal(session.session?.id, sessionId);
      assert.deepEqual(session.session?.labels, [
        'scheduled-task',
        `scheduled-task:${created.task.id}`,
        'scheduled-task-preset:daily-review',
      ]);
    } finally {
      await desktop.close();
      await fixture.stopHost(host);
    }
  });
});

test('production Host settles dispatched Client Capabilities before publishing Ready', async () => {
  await withExecutionRoot(async (fixture) => {
    const prepared = await seedDispatchedClientCapability(fixture);
    const host = await fixture.startHost({
      sessionId: fixture.sessionId,
      runId: prepared.runId,
    });
    try {
      const outcome = host.recoveryOutcome;
      assert.equal(outcome?.content?.kind, 'function_response');
      if (outcome?.content?.kind !== 'function_response') return;
      assert.equal(outcome.content.name, prepared.toolName);
      assert.equal(outcome.content.isError, true);
      assert.ok(outcome.content.result && typeof outcome.content.result === 'object');
      const recovered = outcome.content.result as {
        kind?: unknown;
        uncertainOutcome?: unknown;
      };
      assert.equal(recovered.kind, 'text');
      assert.deepEqual(recovered.uncertainOutcome, {
        code: 'outcome_unknown',
        retrySafe: false,
      });
    } finally {
      await fixture.stopHost(host);
    }
  });
});

test('dual UDS Clients query persisted Task Ledger tool-port mutations across Host restart', async () => {
  await withExecutionRoot(async (fixture) => {
    const initialRunId = randomUUID();
    const initialTurnId = randomUUID();
    // Exercise the Runtime-facing port before Host startup; Hosted tool composition is separate.
    const toolPortProjection = await withOwnedTaskLedgerToolPort(
      fixture,
      async (coordinator, tools) => {
        const context = taskLedgerToolContext(fixture, {
          runId: initialRunId,
          turnId: initialTurnId,
          toolCallId: randomUUID(),
        });
        const create = requireTaskLedgerTool<TaskCreateInput>(tools, 'task_create');
        const createInput = create.parameters.parse({
          tasks: Array.from({ length: TASK_LEDGER_PAGE_MAX_ITEMS + 1 }, (_, index) => ({
            subject: `Authority acceptance task ${index + 1}`,
          })),
        });
        await create.impl(createInput, context);

        const update = requireTaskLedgerTool<TaskUpdateInput>(tools, 'task_update');
        const updateInput = update.parameters.parse({ id: 'T1', status: 'in_progress' });
        await update.impl(updateInput, {
          ...context,
          toolCallId: randomUUID(),
        });
        return coordinator.list(fixture.sessionId, {
          includeTerminal: true,
          includeArchived: false,
          classifyResumeTrust: true,
        });
      },
    );
    assert.equal(toolPortProjection.length, TASK_LEDGER_PAGE_MAX_ITEMS + 1);
    assert.deepEqual(toolPortProjection[0]?.owner, {
      actor: 'main_agent',
      runId: initialRunId,
      turnId: initialTurnId,
    });

    const host = await fixture.startHost();
    const desktop = await connectClient(fixture.root);
    const tui = await connectClient(fixture.root);
    let staleContinuation:
      | {
          revision: TaskLedgerRevision;
          cursor: string;
          task: Task;
        }
      | undefined;
    try {
      const desktopProjection = await collectTaskLedgerProjection(desktop, fixture.sessionId);
      const tuiProjection = await collectTaskLedgerProjection(tui, fixture.sessionId);
      assert.deepEqual(
        desktopProjection.pages.map((page) => page.tasks.length),
        [TASK_LEDGER_PAGE_MAX_ITEMS, 1],
      );
      assert.deepEqual(tuiProjection, desktopProjection);
      assert.deepEqual(desktopProjection.tasks, toolPortProjection);

      const byKey = await tui.request('task.ledger.query', {
        kind: 'get',
        sessionId: fixture.sessionId,
        taskRef: 'T1',
      });
      assert.equal(byKey.kind, 'task');
      if (byKey.kind !== 'task') throw new Error('Expected Task Ledger get result');
      assert.equal(byKey.sessionId, fixture.sessionId);
      assert.deepEqual(byKey.task, desktopProjection.tasks[0]);
      assert.equal(byKey.task?.owner?.runId, initialRunId);
      assert.equal(byKey.task?.owner?.turnId, initialTurnId);

      const firstPage = desktopProjection.pages[0];
      assert.ok(firstPage?.nextCursor);
      staleContinuation = {
        revision: firstPage.revision,
        cursor: firstPage.nextCursor,
        task: desktopProjection.tasks[1]!,
      };
    } finally {
      await Promise.allSettled([desktop.close(), tui.close()]);
      await fixture.stopHost(host);
    }

    assert.ok(staleContinuation);
    const { revision: staleRevision, cursor: staleCursor, task: taskToChange } = staleContinuation;
    const successorTurnId = randomUUID();
    const changedSubject = `${taskToChange.subject} after authority reacquisition`;
    await withOwnedTaskLedgerToolPort(fixture, async (_coordinator, tools) => {
      const update = requireTaskLedgerTool<TaskUpdateInput>(tools, 'task_update');
      const input = update.parameters.parse({
        id: taskToChange.key,
        subject: changedSubject,
      });
      await update.impl(
        input,
        taskLedgerToolContext(fixture, {
          runId: randomUUID(),
          turnId: successorTurnId,
          toolCallId: randomUUID(),
        }),
      );
    });

    const successorHost = await fixture.startHost();
    const successor = await connectClient(fixture.root);
    try {
      const continued = await successor.request('task.ledger.query', {
        kind: 'list_continue',
        sessionId: fixture.sessionId,
        revision: staleRevision,
        cursor: staleCursor,
      });
      assert.equal(continued.kind, 'revision_changed');
      if (continued.kind !== 'revision_changed') {
        throw new Error('Expected stale Task Ledger continuation to report revision_changed');
      }
      assert.equal(continued.expected, staleRevision);
      assert.notEqual(continued.actual, staleRevision);

      const changed = await successor.request('task.ledger.query', {
        kind: 'get',
        sessionId: fixture.sessionId,
        taskRef: taskToChange.key,
      });
      assert.equal(changed.kind, 'task');
      if (changed.kind !== 'task') throw new Error('Expected changed Task Ledger task result');
      assert.equal(changed.sessionId, fixture.sessionId);
      assert.equal(changed.task?.subject, changedSubject);
      assert.equal(changed.revision, continued.actual);
    } finally {
      await successor.close();
      await fixture.stopHost(successorHost);
    }
  });
});

async function seedDispatchedClientCapability(
  fixture: ExecutionFixture,
): Promise<{ runId: string; toolName: string }> {
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire execution root for Client Capability setup');
  let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
  try {
    stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const operationId = 'client-capability-before-ready';
    const invocationId = `${operationId}-invocation`;
    const runId = `${operationId}-run`;
    const turnId = `${operationId}-turn`;
    const providerToolCallId = `${operationId}-call`;
    const toolName = 'mcp__client_fixture__navigate';
    const args = { url: 'https://example.test/recovery' };
    const canonicalArgsHash = canonicalToolArgsHash(toolName, args);
    const call: RuntimeEvent = {
      id: `${operationId}_call`,
      invocationId,
      runId,
      sessionId: fixture.sessionId,
      turnId,
      ts: 10,
      partial: false,
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: providerToolCallId,
        name: toolName,
        args,
      },
      refs: { operationId, toolCallId: providerToolCallId },
    };
    const dispatch: RuntimeEvent = {
      id: `${operationId}_dispatch`,
      invocationId,
      runId,
      sessionId: fixture.sessionId,
      turnId,
      ts: 10,
      partial: false,
      role: 'system',
      author: 'system',
      actions: {
        toolDispatch: {
          protocol: TOOL_BOUNDARY_PROTOCOL_V1,
          operationId,
          providerToolCallId,
          toolName,
          canonicalArgsHash,
          recoveryMode: 'outcome_unknown',
        },
      },
      refs: { operationId, toolCallId: providerToolCallId },
    };
    await stores.runtimeEventStore.commitToolPrepared({
      operationId,
      journalEventId: `${operationId}_prepared`,
      runtimeEvent: call,
      dispatchRuntimeEvent: dispatch,
      providerToolCallId,
      toolName,
      canonicalArgsHash,
      recoveryMode: 'outcome_unknown',
      committedAt: 10,
    });
    return { runId, toolName };
  } finally {
    await stores?.sessionStore.close?.();
    await owner.close();
  }
}

test('two UDS Clients share one Runtime Policy authority and CAS winner', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root);
    const second = await connectClient(fixture.root);
    try {
      const initial = await first.request('runtime.policy.query', {});
      assert.deepEqual(await second.request('runtime.policy.query', {}), initial);
      const outcomes = await Promise.all([
        first.request('runtime.policy.mutate', {
          expectedRevision: initial.revision,
          operation: {
            kind: 'set_personalization',
            value: { displayName: 'Desktop', assistantTone: 'precise' },
          },
        }),
        second.request('runtime.policy.mutate', {
          expectedRevision: initial.revision,
          operation: {
            kind: 'set_memory',
            value: { enabled: false, agentReadEnabled: false },
          },
        }),
      ]);
      assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), [
        'committed',
        'revision_conflict',
      ]);
      assert.deepEqual(
        await first.request('runtime.policy.query', {}),
        await second.request('runtime.policy.query', {}),
      );
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await fixture.stopHost(host);
    }
  });
});

test('two UDS Clients serialize same-provider account creation through one Host lane', async () => {
  const provider = await startConnectionEffectProvider({ responseDelayMs: 50 });
  try {
    await withExecutionRoot(async (fixture) => {
      const host = await fixture.startHost();
      const desktop = await connectClient(fixture.root);
      const tui = await connectClient(fixture.root);
      const secrets = ['desktop-account-secret', 'tui-account-secret'] as const;
      let identities: Array<{ connectionId: string; slug: string }> = [];
      try {
        const results = await Promise.all(
          [desktop, tui].map((client, index) =>
            client.request('connection.onboarding.save', {
              target: { kind: 'create', providerType: 'openai-compatible' },
              apiKey: secrets[index]!,
              baseUrl: provider.baseUrl,
              enabledModelIds: [CONNECTION_EFFECT_MODEL_IDS[0]!],
            }),
          ),
        );
        assert.ok(results.every((result) => result.kind === 'saved'));
        identities = results.map((result) => {
          if (result.kind !== 'saved') throw new Error('Onboarding did not save');
          return {
            connectionId: result.connection.connectionId,
            slug: result.connection.slug,
          };
        });
        assert.notEqual(identities[0]?.connectionId, identities[1]?.connectionId);
        assert.deepEqual(identities.map(({ slug }) => slug).sort(), [
          'openai-compatible',
          'openai-compatible-2',
        ]);
      } finally {
        await Promise.allSettled([desktop.close(), tui.close()]);
        await fixture.stopHost(host);
      }

      const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
      assert.ok(owner);
      if (!owner) return;
      try {
        const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
        const catalog = await stores.connectionCatalog.getSnapshot();
        assert.deepEqual(
          catalog.connections
            .filter(({ providerType }) => providerType === 'openai-compatible')
            .map(({ connectionId, slug }) => ({ connectionId, slug }))
            .sort((left, right) => left.slug.localeCompare(right.slug)),
          [...identities].sort((left, right) => left.slug.localeCompare(right.slug)),
        );
        for (const [index, identity] of identities.entries()) {
          assert.equal(
            (
              await stores.operations.exportCredentialMaterial({
                scope: 'connection',
                connectionId: identity.connectionId,
                kind: 'api_key',
              })
            )?.secret,
            secrets[index],
          );
        }
      } finally {
        await owner.close();
      }
      assert.deepEqual(
        provider.requests.map(({ authorization }) => authorization).sort(),
        secrets.map((secret) => `Bearer ${secret}`).sort(),
      );
    });
  } finally {
    await provider.close();
  }
});

test('two UDS Clients await slow connection effects against one canonical catalog', async () => {
  const provider = await startConnectionEffectProvider({ responseDelayMs: 2_100 });
  try {
    await withExecutionRoot(async (fixture) => {
      const secret = 'connection-effect-secret';
      const connection = await fixture.seedConnectionEffect(provider.baseUrl, secret);
      const host = await fixture.startHost();
      const desktop = await connectClient(fixture.root);
      const tui = await connectClient(fixture.root);
      try {
        assert.equal(desktop.hostEpoch, tui.hostEpoch);
        assert.notEqual(desktop.connectionId, tui.connectionId);
        const fetchInput = { connectionId: connection.connectionId };
        const fetched = await desktop.request('connection.models.fetch', {
          ...fetchInput,
        });
        assert.equal(fetched.kind, 'committed');
        if (fetched.kind !== 'committed') return;
        assert.equal(fetched.modelCount, CONNECTION_EFFECT_MODEL_IDS.length);
        assert.equal(fetched.source, 'fetched');

        const firstPage = await tui.request('connection.catalog.query', { kind: 'start' });
        assert.equal(firstPage.kind, 'page');
        if (firstPage.kind !== 'page') return;
        type CatalogPage = Extract<ConnectionCatalogQueryResult, { readonly kind: 'page' }>;
        const pages: CatalogPage[] = [firstPage];
        let observed: CatalogPage = firstPage;
        while (observed.nextCursor) {
          const nextResult: ConnectionCatalogQueryResult = await tui.request(
            'connection.catalog.query',
            {
              kind: 'continue',
              revision: observed.revision,
              cursor: observed.nextCursor,
            },
          );
          assert.equal(nextResult.kind, 'page');
          if (nextResult.kind !== 'page') return;
          pages.push(nextResult);
          observed = nextResult;
        }
        assert.ok(pages.length > 1);
        assert.ok(pages.every((page) => page.revision === fetched.catalogRevision));
        assert.deepEqual(
          pages.flatMap((page) =>
            page.items.flatMap((item) => (item.kind === 'model' ? [item.model.id] : [])),
          ),
          CONNECTION_EFFECT_MODEL_IDS,
        );

        const testInput = {
          connectionId: connection.connectionId,
          modelId: CONNECTION_EFFECT_MODEL_IDS[0]!,
        };
        const tested = await tui.request('connection.test.run', {
          ...testInput,
        });
        assert.equal(tested.kind, 'committed');
        if (tested.kind !== 'committed') return;
        assert.equal(tested.test.kind, 'verified');

        const canonical = await desktop.request('connection.catalog.query', { kind: 'start' });
        assert.equal(canonical.kind, 'page');
        if (canonical.kind !== 'page') return;
        const header = canonical.items.find(
          (item) => item.kind === 'connection' && item.connectionId === connection.connectionId,
        );
        assert.equal(header?.kind, 'connection');
        if (header?.kind === 'connection') {
          assert.deepEqual(header.lastTest, {
            status: 'verified',
            checkedAt: tested.test.checkedAt,
          });
        }
        assert.equal(
          JSON.stringify([fetchInput, fetched, pages, testInput, tested, canonical]).includes(
            secret,
          ),
          false,
        );
        assert.equal(provider.requests.length, 2);
        assert.ok(
          provider.requests.every(({ authorization }) => authorization === `Bearer ${secret}`),
        );
        assert.deepEqual(
          provider.requests.map(({ method, url }) => ({
            method,
            url,
          })),
          [
            {
              method: 'GET',
              url: '/v1/models',
            },
            {
              method: 'POST',
              url: '/v1/chat/completions',
            },
          ],
        );
      } finally {
        await Promise.allSettled([desktop.close(), tui.close()]);
        await fixture.stopHost(host);
      }
    });
  } finally {
    await provider.close();
  }
});

test('two Clients share one execution after the starting Client disconnects', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root);
    const second = await connectClient(fixture.root);
    const turnId = randomUUID();

    const started = requireStartedTurn(
      await first.request(
        'turn.start',
        {
          sessionId: fixture.sessionId,
          turnId,
          content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        },
        PROCESS_TIMEOUT_MS,
      ),
    );
    assert.equal(started.turnId, turnId);
    const secondSubscription = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'tail', maxBytes: 16 * 1024 },
    });
    const transcript = await secondSubscription.loadTranscript(decodeStoredMessage);
    assert.ok(
      transcript.some(
        (message) =>
          message.type === 'user' &&
          message.turnId === turnId &&
          message.text === FAKE_ASK_USER_QUESTION_PROMPT,
      ),
    );
    const secondProbe = new SubscriptionProbe(secondSubscription);
    await assert.rejects(
      () =>
        second.request(
          'turn.start',
          {
            sessionId: fixture.sessionId,
            turnId: randomUUID(),
            content: { text: 'must stay busy' },
          },
          PROCESS_TIMEOUT_MS,
        ),
      operationError('session_busy'),
    );

    await first.close();
    const pending = await waitForPendingInteraction(secondSubscription, secondProbe, started.runId);
    assert.equal(pending.sessionId, fixture.sessionId);
    assert.equal(pending.turnId, turnId);
    assert.equal(pending.runId, started.runId);
    const questionRequest = pending.request;
    assert.ok(questionRequest.kind === 'question');
    assert.deepEqual(
      await second.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      pending,
    );
    const observed = await second.request('turn.query', {
      sessionId: fixture.sessionId,
      turnId,
    });
    assert.equal(observed.runId, started.runId);
    assert.ok(observed.status === 'running' || observed.status === 'waiting_for_user');
    const stopped = await second.request(
      'turn.stop',
      {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    assert.equal(stopped.status, 'cancelled');
    const closed = await second.request('interaction.query', {
      sessionId: fixture.sessionId,
      interactionId: pending.interactionId,
    });
    assert.equal(closed.sessionId, fixture.sessionId);
    assert.equal(closed.turnId, turnId);
    assert.equal(closed.runId, started.runId);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.outcome.kind, 'closure');
    if (closed.outcome.kind === 'closure') assert.equal(closed.outcome.reason, 'turn_stopped');
    await assert.rejects(
      () =>
        second.request('interaction.answer', {
          sessionId: fixture.sessionId,
          interactionId: pending.interactionId,
          answer: {
            kind: 'question',
            answers: questionRequest.questions.map(() => null),
          },
        }),
      operationError('already_resolved'),
    );

    const nextTurnId = randomUUID();
    const next = requireStartedTurn(
      await second.request(
        'turn.start',
        {
          sessionId: fixture.sessionId,
          turnId: nextTurnId,
          content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        },
        PROCESS_TIMEOUT_MS,
      ),
    );
    assert.deepEqual(
      requireStartedTurn(
        await second.request(
          'turn.start',
          {
            sessionId: fixture.sessionId,
            turnId,
            content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
          },
          PROCESS_TIMEOUT_MS,
        ),
      ),
      stopped,
    );
    assert.deepEqual(
      await second.request('turn.stop', {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      }),
      stopped,
    );
    const nextObserved = await second.request('turn.query', {
      sessionId: fixture.sessionId,
      turnId: nextTurnId,
    });
    assert.equal(nextObserved.runId, next.runId);
    assert.ok(nextObserved.status === 'running' || nextObserved.status === 'waiting_for_user');
    await second.request(
      'turn.stop',
      {
        sessionId: fixture.sessionId,
        turnId: nextTurnId,
        runId: next.runId,
      },
      PROCESS_TIMEOUT_MS,
    );
    await secondSubscription.close();
    await secondProbe.done;
    await second.close();
    await fixture.stopHost(host);

    const ledger = await fixture.readTurn(turnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.terminalEvents.length, 1);
    assert.equal(ledger.classification.kind, 'fact');
    if (ledger.classification.kind === 'fact') {
      assert.equal(ledger.classification.fact.runStatus, 'cancelled');
      assert.notEqual(ledger.classification.fact.failureClass, 'app_restarted');
    }
  });
});

test('regenerate replays the durable source content with one recoverable root identity', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const client = await connectClient(fixture.root);
    const sourceTurnId = randomUUID();
    const regeneratedTurnId = randomUUID();
    try {
      await client.request(
        'turn.start',
        {
          sessionId: fixture.sessionId,
          turnId: sourceTurnId,
          content: quotedContent('repeat this request'),
        },
        PROCESS_TIMEOUT_MS,
      );
      await waitForTerminalTurn(client, fixture.sessionId, sourceTurnId);

      const started = await client.request(
        'turn.regenerate',
        {
          sessionId: fixture.sessionId,
          sourceTurnId,
          turnId: regeneratedTurnId,
        },
        PROCESS_TIMEOUT_MS,
      );
      const terminal = await waitForTerminalTurn(client, fixture.sessionId, regeneratedTurnId);
      assert.equal(terminal.runId, started.runId);
      assert.deepEqual(
        await client.request('turn.regenerate', {
          sessionId: fixture.sessionId,
          sourceTurnId,
          turnId: regeneratedTurnId,
        }),
        terminal,
      );
    } finally {
      await client.close();
      await fixture.stopHost(host);
    }

    const ledger = await fixture.readTurn(regeneratedTurnId);
    assert.equal(ledger.runs.length, 1);
    assert.equal(ledger.userMessages.length, 1);
    assert.equal(ledger.runs[0]?.parentTurnId, sourceTurnId);
    assert.equal(ledger.runs[0]?.regeneratedFromTurnId, sourceTurnId);
    assert.deepEqual(
      {
        text: ledger.userMessages[0]?.text,
        quotes: ledger.userMessages[0]?.quotes,
      },
      quotedContent('repeat this request'),
    );
  });
});

test('regenerate rejects self-source and legacy target collisions without draining Host', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root);
    const sourceTurnId = randomUUID();
    await first.request('turn.start', {
      sessionId: fixture.sessionId,
      turnId: sourceTurnId,
      content: { text: 'source request' },
    });
    await waitForTerminalTurn(first, fixture.sessionId, sourceTurnId);
    await assert.rejects(
      first.request('turn.regenerate', {
        sessionId: fixture.sessionId,
        sourceTurnId,
        turnId: sourceTurnId,
      }),
      operationError('operation_conflict'),
    );
    await first.close();
    await fixture.stopHost(firstHost);

    const legacy = await fixture.seedSafeBoundaryContinuationSource();
    const secondHost = await fixture.startHost();
    const second = await connectClient(fixture.root);
    try {
      await assert.rejects(
        second.request('turn.regenerate', {
          sessionId: fixture.sessionId,
          sourceTurnId,
          turnId: legacy.sourceTurnId,
        }),
        operationError('operation_conflict'),
      );
      const followingTurnId = randomUUID();
      await second.request('turn.start', {
        sessionId: fixture.sessionId,
        turnId: followingTurnId,
        content: { text: 'Host remains available' },
      });
      assert.equal(
        (await waitForTerminalTurn(second, fixture.sessionId, followingTurnId)).status,
        'completed',
      );
    } finally {
      await second.close();
      await fixture.stopHost(secondHost);
    }
    assert.deepEqual(await fixture.readTurnFootprint(legacy.sourceTurnId), {
      admitted: false,
      runCount: 1,
      userMessageCount: 0,
    });
  });
});

test('context actions share root admission and expose backend capability honestly', async () => {
  await withExecutionRoot(async (fixture) => {
    const host = await fixture.startHost();
    const first = await connectClient(fixture.root);
    const second = await connectClient(fixture.root);
    const turnId = randomUUID();
    const unavailableTurnId = randomUUID();
    try {
      assert.deepEqual(
        await first.request('context.diagnostics.query', {
          sessionId: fixture.sessionId,
        }),
        {
          status: 'unavailable',
          reason: 'no_completed_request',
        },
      );
      const started = requireStartedTurn(
        await first.request('turn.start', {
          sessionId: fixture.sessionId,
          turnId,
          content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        }),
      );
      await waitForRunningTurn(second, fixture.sessionId, turnId);
      await assert.rejects(
        second.request('context.compact', {
          sessionId: fixture.sessionId,
          turnId: randomUUID(),
        }),
        operationError('session_busy'),
      );
      await second.request('turn.stop', {
        sessionId: fixture.sessionId,
        turnId,
        runId: started.runId,
      });
      await assert.rejects(
        second.request('context.compact', {
          sessionId: fixture.sessionId,
          turnId: unavailableTurnId,
        }),
        operationError('operation_unavailable'),
      );
      await assert.rejects(
        second.request('context.diagnostics.query', { sessionId: 'missing-session' }),
        operationError('not_found'),
      );
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await fixture.stopHost(host);
    }
    assert.deepEqual(await fixture.readTurnFootprint(unavailableTurnId), {
      admitted: false,
      runCount: 0,
      userMessageCount: 0,
    });
  });
});

test('a disconnected Client leaves a durable Interaction that another Client can answer', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const first = await connectClient(fixture.root);
    const turnId = randomUUID();
    const started = requireStartedTurn(
      await first.request('turn.start', {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
      }),
    );
    await first.close();

    const second = await connectClient(fixture.root);
    const subscription = await second.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'none' },
    });
    const probe = new SubscriptionProbe(subscription);
    const pending = await waitForPendingInteraction(subscription, probe, started.runId);
    assert.equal(pending.sessionId, fixture.sessionId);
    assert.equal(pending.turnId, turnId);
    assert.equal(pending.runId, started.runId);
    assert.equal(pending.status, 'pending');
    const questionRequest = pending.request;
    assert.ok(questionRequest.kind === 'question');

    assert.deepEqual(
      await second.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      pending,
    );
    const answer = {
      kind: 'question' as const,
      answers: questionRequest.questions.map((question) => question.options[0]?.label ?? null),
    };
    const winner = await second.request('interaction.answer', {
      sessionId: fixture.sessionId,
      interactionId: pending.interactionId,
      answer,
    });
    assert.equal(winner.sessionId, fixture.sessionId);
    assert.equal(winner.turnId, turnId);
    assert.equal(winner.runId, started.runId);
    assert.equal(winner.status, 'answered');
    assert.equal(winner.outcome.kind, 'question_answer');
    assert.deepEqual(winner.outcome.answers, answer.answers);
    assert.deepEqual(
      await second.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      winner,
    );
    assert.deepEqual(
      await second.request('interaction.answer', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
        answer,
      }),
      winner,
    );
    const resumed = await probe.waitFor(
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.session.status === 'running' &&
        frame.snapshot.rootTurn?.runId === started.runId &&
        frame.snapshot.rootTurn.status === 'running' &&
        frame.snapshot.interactions.pending.length === 0,
      'continuity did not publish the resumed Turn after the question answer',
    );
    assert.equal(resumed.kind, 'subscription.session_projection');
    const completed = await waitForTerminalTurn(second, fixture.sessionId, turnId);
    assert.equal(completed.runId, started.runId);
    assert.equal(completed.status, 'completed');
    await subscription.close();
    await probe.done;
    await second.close();
    await fixture.stopHost(firstHost);

    const secondHost = await fixture.startHost();
    const observer = await connectClient(fixture.root);
    assert.deepEqual(
      await observer.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      winner,
    );
    assert.deepEqual(
      await observer.request('interaction.answer', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
        answer,
      }),
      winner,
    );
    assert.deepEqual(
      await observer.request('turn.query', { sessionId: fixture.sessionId, turnId }),
      completed,
    );
    await observer.close();
    await fixture.stopHost(secondHost);
  });
});

test('two UDS Clients settle one hosted sandbox boundary and resume its exact Run', async () => {
  await withExecutionRoot(async (fixture) => {
    const firstHost = await fixture.startHost();
    const starter = await connectClient(fixture.root);
    const first = await connectClient(fixture.root);
    const second = await connectClient(fixture.root);
    const subscription = await first.openSessionSubscription({
      sessionId: fixture.sessionId,
      transcript: { kind: 'none' },
    });
    const probe = new SubscriptionProbe(subscription);
    const turnId = randomUUID();
    const started = requireStartedTurn(
      await starter.request('turn.start', {
        sessionId: fixture.sessionId,
        turnId,
        content: { text: FAKE_ASK_SANDBOX_BOUNDARY_PROMPT },
      }),
    );
    await starter.close();

    const pending = await waitForPendingInteraction(subscription, probe, started.runId);
    assert.equal(pending.sessionId, fixture.sessionId);
    assert.equal(pending.turnId, turnId);
    assert.equal(pending.runId, started.runId);
    assert.equal(pending.status, 'pending');
    assert.equal(pending.request.kind, 'sandbox_boundary');
    if (pending.request.kind !== 'sandbox_boundary') return;
    assert.deepEqual(pending.request.expansion, { network: { enabled: true } });

    const answer = {
      sessionId: fixture.sessionId,
      interactionId: pending.interactionId,
      answer: { kind: 'sandbox_boundary', decision: 'allow' },
    } as const;
    const [firstWinner, secondWinner] = await Promise.all([
      first.request('interaction.answer', answer),
      second.request('interaction.answer', answer),
    ]);
    assert.deepEqual(firstWinner, secondWinner);
    assert.equal(firstWinner.status, 'answered');
    assert.equal(firstWinner.outcome.kind, 'sandbox_boundary_decision');
    if (firstWinner.outcome.kind !== 'sandbox_boundary_decision') return;
    assert.equal(firstWinner.outcome.decision, 'allow');
    assert.equal(firstWinner.outcome.status, 'approved');
    assert.equal(Number.isSafeInteger(firstWinner.outcome.committedAt), true);
    assert.deepEqual(
      await first.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      firstWinner,
    );
    await probe.waitFor(
      (frame) =>
        frame.kind === 'subscription.session_projection' &&
        frame.snapshot.rootTurn?.runId === started.runId &&
        frame.snapshot.interactions.pending.length === 0,
      'continuity did not publish the resumed Turn after the sandbox boundary answer',
    );
    const completed = await waitForTerminalTurn(first, fixture.sessionId, turnId);
    assert.equal(completed.runId, started.runId);
    assert.equal(completed.status, 'completed');

    await subscription.close();
    await probe.done;
    await Promise.allSettled([first.close(), second.close()]);
    await fixture.stopHost(firstHost);

    const secondHost = await fixture.startHost();
    const observer = await connectClient(fixture.root);
    assert.deepEqual(
      await observer.request('interaction.query', {
        sessionId: fixture.sessionId,
        interactionId: pending.interactionId,
      }),
      firstWinner,
    );
    assert.deepEqual(
      await observer.request('turn.query', { sessionId: fixture.sessionId, turnId }),
      completed,
    );
    await observer.close();
    await fixture.stopHost(secondHost);
  });
});

interface TaskCreateInput {
  tasks: Array<{ subject: string; parent_id?: string }>;
}

interface TaskUpdateInput {
  id: string;
  status?: 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed' | 'cancelled';
  subject?: string;
  blockedReason?: string;
  failureReason?: string;
  completionEvidence?: string;
  explicitReopen?: boolean;
}

type TaskLedgerPage = Extract<TaskLedgerQueryResult, { kind: 'page' }>;
type TaskLedgerTool<Input> = MakaTool<Input, string> & {
  parameters: { parse(value: unknown): Input };
};

async function withOwnedTaskLedgerToolPort<T>(
  fixture: ExecutionFixture,
  run: (coordinator: HostTaskLedgerCoordinator, tools: MakaTool[]) => Promise<T>,
): Promise<T> {
  const owner = await tryAcquireInteractiveRootOwner(fixture.capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire the interactive Task Ledger tool port');
  let writer: Awaited<ReturnType<typeof openInteractiveTaskLedgerStoreForWrite>> | undefined;
  try {
    writer = await openInteractiveTaskLedgerStoreForWrite(owner.lease);
    const coordinator = new HostTaskLedgerCoordinator(writer, new SessionAdmissionGate(), {
      probeSessionRemoval: async () => ({ kind: 'present' }),
    });
    return await run(coordinator, buildTaskLedgerTools({ store: coordinator }));
  } finally {
    writer?.close();
    await owner.close();
  }
}

function requireTaskLedgerTool<Input>(
  tools: readonly MakaTool[],
  name: 'task_create' | 'task_update',
): TaskLedgerTool<Input> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `Expected ${name} Runtime tool`);
  return tool as TaskLedgerTool<Input>;
}

function taskLedgerToolContext(
  fixture: ExecutionFixture,
  identity: Pick<MakaToolContext, 'runId' | 'turnId' | 'toolCallId'>,
): MakaToolContext {
  return {
    sessionId: fixture.sessionId,
    cwd: fixture.root,
    ...identity,
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

async function collectTaskLedgerProjection(
  client: RuntimeHostConnection,
  sessionId: string,
): Promise<{
  revision: TaskLedgerRevision;
  pages: TaskLedgerPage[];
  tasks: Task[];
}> {
  const pages: TaskLedgerPage[] = [];
  let result = await client.request('task.ledger.query', {
    kind: 'list_start',
    sessionId,
  });
  assert.equal(result.kind, 'page');
  if (result.kind !== 'page') throw new Error('Expected initial Task Ledger page');
  const revision = result.revision;

  while (true) {
    assert.equal(result.sessionId, sessionId);
    assert.equal(result.revision, revision);
    pages.push(result);
    if (result.nextCursor === null) break;
    result = await client.request('task.ledger.query', {
      kind: 'list_continue',
      sessionId,
      revision,
      cursor: result.nextCursor,
    });
    assert.equal(result.kind, 'page');
    if (result.kind !== 'page') {
      throw new Error('Task Ledger changed while collecting a stable projection');
    }
  }

  return {
    revision,
    pages,
    tasks: pages.flatMap((page) => page.tasks),
  };
}

async function waitForScheduledTaskCompletion(
  client: RuntimeHostConnection,
  taskId: string,
): Promise<ScheduledTask> {
  const deadline = Date.now() + 20_000;
  let last: ScheduledTask | null = null;
  while (Date.now() < deadline) {
    const result = await client.request('scheduled-task.query', {
      kind: 'get',
      taskId,
    });
    if (result.kind === 'task' && result.task?.status === 'completed') return result.task;
    if (result.kind === 'task') last = result.task;
    if (result.kind === 'task' && result.task?.lastError) {
      throw new Error(`ScheduledTask execution failed: ${result.task.lastError}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `ScheduledTask ${taskId} did not settle before the deadline: ${JSON.stringify(last)}`,
  );
}
