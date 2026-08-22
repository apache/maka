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
import { parseNoRealConnectionError } from '@maka/core/connection-error-copy';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type {
  AgentGraphIntentClaim,
  AgentGraphIntentClaimRequest,
} from '@maka/core/agent-graph-control';
import type { ShellRunRecord } from '@maka/core/shell-run';
import { FAKE_ASK_USER_QUESTION_PROMPT, FakeBackend } from '@maka/runtime/test-only/fake-backend';
import { LOCAL_READ_AGENT_DEFINITION } from '@maka/runtime/agent-catalog';
import { SessionManager } from '@maka/runtime/session-manager';
import { fingerprintAgentGraphRunnableIntent } from '@maka/runtime/stream-graph-admission';
import type { AgentGraphRunnableIntent } from '@maka/runtime/stream-graph-readiness';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import {
  LONG_TERM_MEMORY_DATABASE_NAME,
  openInteractiveLongTermMemoryStoreForWrite,
} from '@maka/storage/long-term-memory-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { openInteractiveShellRunStoreForWrite } from '@maka/storage/shell-run-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { HostResidencyRegistry } from '../server/host-residency-registry.js';
import {
  createExecutionRuntimeHostComposition,
  runtimeHostFilesystemWorkerRuntime,
} from '../server/execution-composition.js';
import {
  createManagedWorkspaceExecutionProfile,
  RuntimeHostWorkspaceExecutionError,
} from '../server/workspace-execution-composition.js';

const require = createRequire(import.meta.url);

test('filesystem worker follows the candidate executable runtime', () => {
  assert.equal(runtimeHostFilesystemWorkerRuntime({ electron: '43.1.1' }), 'electron');
  assert.equal(runtimeHostFilesystemWorkerRuntime({}), 'node');
});

test('production composition never discovers PATH Git when no runtime is admitted', async () => {
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['--version'], (error) => (error ? reject(error) : resolve()));
  });

  await withCompositionRoot(async ({ owner }) => {
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      assert.equal(composition.workspaceExecution.state, 'ready');
      const managed = createManagedWorkspaceExecutionProfile(
        Object.freeze({ kind: 'managed_workspace_execution_handle_v1' }),
      );
      await assert.rejects(
        () =>
          composition.workspaceExecution.executeReadOnly(managed, {
            kind: 'read',
            path: 'README.md',
          }),
        (error) =>
          error instanceof RuntimeHostWorkspaceExecutionError &&
          error.code === 'managed_workspace_profile_unavailable',
      );
    } finally {
      await composition.close();
    }
  });
});

test('production composition owns the long-term memory database lifecycle', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
    await assert.rejects(stat(databasePath), { code: 'ENOENT' });

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const workspaceExecution = composition.workspaceExecution;
    assert.equal(workspaceExecution.state, 'ready');
    const memory = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);
    assert.equal((await stat(databasePath)).isFile(), true);

    composition.beginDrain();
    assert.equal(workspaceExecution.state, 'draining');
    await composition.close();
    assert.equal(workspaceExecution.state, 'closed');
    await assert.rejects(memory.readItem('after-close'), /closed/);
    const Database = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
    const database = new Database(databasePath);
    try {
      const counts = database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM memory_items) AS item_count,
             (SELECT COUNT(*) FROM memory_write_operations) AS operation_count`,
        )
        .get() as { item_count?: unknown; operation_count?: unknown };
      assert.equal(counts.item_count, 0);
      assert.equal(counts.operation_count, 0);
    } finally {
      database.close();
    }
  });
});

test('production composition closes long-term memory after a later startup failure', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const memory = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);

    // Fail the composition after the memory store is opened: beginHostEpoch
    // runs later in the startup sequence and rejects an invalid host epoch,
    // so the composition must close every resource it opened, including
    // long-term memory.
    await assert.rejects(
      createExecutionRuntimeHostComposition({
        ...compositionContext(owner),
        hostEpoch: 'invalid host epoch!',
      }),
    );
    await assert.rejects(memory.readItem('after-failed-start'), /closed/);

    await owner.close();
    const recoveredCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const recoveredOwner = await tryAcquireInteractiveRootOwner(recoveredCapability);
    assert.ok(recoveredOwner);
    if (!recoveredOwner) return;
    try {
      const recovered = await createExecutionRuntimeHostComposition(
        compositionContext(recoveredOwner),
      );
      await recovered.close();
    } finally {
      await recoveredOwner.close();
    }
  });
});

test('production recovery preserves legacy Automation history and closes an orphaned admission', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const historical = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const pending = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const admitted = await stores.agentRunStore.admitRootTurn({
      sessionId: pending.id,
      turnId: 'legacy-automation-turn',
      proposedRunId: 'legacy-automation-run',
      proposedUserMessageId: 'legacy-automation-message',
      execution: { kind: 'scheduled_task', scheduledTaskId: 'legacy-automation' },
      previousRootTurnId: null,
      normalizedInput: { text: 'Run the legacy Automation' },
      sourceMessages: [],
      admittedAt: 1,
    });
    assert.equal(admitted.kind, 'admitted');

    const Database = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
    const database = new Database(join(root, 'runtime.sqlite'));
    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(`
          INSERT INTO session_messages(
            session_id, sequence, message_id, message_type, message_ts, record_json
          ) VALUES (?, 0, ?, 'user', 1, ?)
        `)
        .run(
          historical.id,
          'historical-automation-message',
          JSON.stringify({
            type: 'user',
            id: 'historical-automation-message',
            turnId: 'historical-automation-turn',
            ts: 1,
            text: 'Historical Automation prompt',
            origin: { kind: 'automation', automationId: 'historical-automation' },
          }),
        );
      const row = database
        .prepare(`
          SELECT record_json
          FROM core_root_turn_admissions
          WHERE session_id = ? AND turn_id = 'legacy-automation-turn'
        `)
        .get(pending.id) as { record_json: string };
      const record = JSON.parse(row.record_json) as Record<string, unknown>;
      record.execution = { kind: 'automation', automationId: 'legacy-automation' };
      database
        .prepare(`
          UPDATE core_root_turn_admissions
          SET record_json = ?
          WHERE session_id = ? AND turn_id = 'legacy-automation-turn'
        `)
        .run(JSON.stringify(record), pending.id);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database.close();

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const history = await stores.sessionStore.readMessages(historical.id);
      assert.deepEqual(history[0]?.type === 'user' ? history[0].origin : undefined, {
        kind: 'legacy_automation',
        automationId: 'historical-automation',
      });
      const recoveredRun = await stores.agentRunStore.readRun(pending.id, 'legacy-automation-run');
      assert.equal(recoveredRun.status, 'failed');
      assert.equal(recoveredRun.legacyAutomationId, 'legacy-automation');
      assert.equal(recoveredRun.failureClass, 'app_restarted');
    } finally {
      await composition.close();
    }
  });
});

test('composition drain preserves usage admission until active Runtime work settles', async () => {
  await withCompositionRoot(async ({ owner }) => {
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const usage = await openInteractiveUsageStoresForWrite(owner.lease);
    composition.beginDrain();

    await usage.telemetry.recordLlmCall(lifecycleUsageRecord());
    const persisted = await usage.telemetry.logs({ range: 'all' }, 0, 10);
    assert.deepEqual(
      persisted.rows.map((row) => row.id),
      ['usage_after_composition_drain'],
    );

    await composition.close();
  });
});

test('hosted execution settles while its tracked environment resource remains verifiable', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'hosted-fake',
        name: 'Hosted fake',
        providerType: 'ollama',
        enabled: true,
        enabledModelIds: ['fake-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    const fetch = await policy.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') return;
    const fetched = await policy.operations.completeModelFetch(fetch.ticket, {
      models: [{ id: 'fake-model' }],
      source: 'fetched',
      fetchedAt: Date.now(),
    });
    assert.equal(fetched.kind, 'committed');
    if (fetched.kind !== 'committed') return;
    const defaultTarget = await policy.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: fetched.snapshot.revision,
      target: { connectionId: connection.connectionId, modelId: 'fake-model' },
    });
    assert.equal(defaultTarget.kind, 'committed');

    const residencies = new HostResidencyRegistry();
    let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>;
    const operationContext = {
      hostEpoch: 'hosted-environment-test',
      connectionId: 'hosted-environment-test',
      principal: 'runtime_host' as const,
      acquireResidency: () => ({ release() {} }),
    };
    composition = await createExecutionRuntimeHostComposition(
      {
        owner,
        hostEpoch: operationContext.hostEpoch,
        acquireResidency: (label) => residencies.acquire(label),
        retainUntilProcessExit: () => undefined,
        requestDrain: () => composition?.beginDrain(),
        waitForResidencies: () => residencies.waitForEmpty(),
        waitForResidenciesExcept: (label) => residencies.waitForEmptyExcept(label),
      },
      { bootstrapRuntimePolicy: false },
      {
        primaryBackendFactory: (backendContext) => {
          const backend = new FakeBackend(backendContext);
          const send = backend.send.bind(backend);
          backend.send = async function* (input) {
            if (input.text === 'leave the environment ready for verification') {
              const started = await composition.handlers['runtime.resource.start'](
                { sessionId: backendContext.sessionId, launchId: input.turnId },
                operationContext,
              );
              assert.equal(started.ok, true);
            }
            yield* send(input);
          };
          return backend;
        },
      },
    );
    try {
      await composition.recover();
      const executionId = '00000000-0000-4000-8000-000000000111';
      const execution = composition.handlers['hosted.execution.start'](
        {
          executionId,
          session: {
            workspace: { kind: 'host_path', path: root },
            modelTarget: { kind: 'default' },
            name: 'Hosted environment test',
          },
          content: { text: 'leave the environment ready for verification' },
        },
        operationContext,
      );
      let settled = false;
      void execution.then(() => {
        settled = true;
      });
      try {
        await waitFor(async () => settled, 5_000);
      } catch {
        assert.fail(`Hosted execution did not settle: ${JSON.stringify(residencies.snapshot())}`);
      }
      const result = await execution;
      assert.equal(result.ok, true);
      if (!result.ok) return;
      if (result.result.kind !== 'settled') assert.fail(result.result.failureReason);

      const resources = await composition.handlers['runtime.resource.query'](
        { kind: 'list_start', sessionId: executionId },
        operationContext,
      );
      assert.equal(resources.ok, true);
      if (!resources.ok || resources.result.kind !== 'page') return;
      assert.equal(
        resources.result.resources.some((item) => item.result.status === 'running'),
        true,
      );
    } finally {
      composition.beginDrain();
      await composition.close();
    }
  });
});

test('production composition commits automatic titles through Host-owned Session effects', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const { composition, manager } = await createCapturedExecutionComposition(owner);
    try {
      const session = await manager.createSession({
        cwd: root,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const started = await composition.handlers['turn.start'](
        {
          sessionId: session.id,
          turnId: 'turn-title',
          content: { text: 'Host owns this automatic title' },
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'title-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.equal(started.ok, true);
      await waitFor(async () => {
        const summary = (await manager.listSessions()).find((item) => item.id === session.id);
        return summary?.name === 'Host owns this automatic title';
      });
    } finally {
      await composition.close();
    }
  });
});

test('a legacy fake-backend session is refused with the product reason, not a registry error', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    // Written by an older build: no creation path here can produce `fake`, so
    // the row is seeded under the writer — which is the only way it was ever
    // produced — and then read back by a Host that starts up against it, since
    // activation dispatches straight off the durable header.
    const legacyId = await seedLegacyFakeBackendSession(root, owner);
    const { composition } = await createCapturedExecutionComposition(owner);
    try {
      const failure = await composition.handlers['turn.start'](
        {
          sessionId: legacyId,
          turnId: 'turn-legacy-fake',
          content: { text: 'resume a retired local simulation' },
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'legacy-fake-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      ).then(
        (result) => result,
        (error: unknown) => error,
      );
      const message = failure instanceof Error ? failure.message : JSON.stringify(failure);
      assert.doesNotMatch(message, /No backend factory registered/);
      assert.equal(parseNoRealConnectionError(message).reason, 'fake_backend');
    } finally {
      await composition.close();
    }
  });
});

test('production composition orphans ownerless ShellRuns before serving Resource queries', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const shellRuns = await openInteractiveShellRunStoreForWrite(owner.lease);
    await shellRuns.createShellRun(shellRunRecord(session.id, 'starting-shell', 'starting'));
    await shellRuns.createShellRun(shellRunRecord(session.id, 'running-shell', 'running'));

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const outcome = await composition.handlers['runtime.resource.query'](
        { kind: 'list_start', sessionId: session.id },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'recovery-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.equal(outcome.ok, true);
      if (!outcome.ok || outcome.result.kind !== 'page') return;
      assert.equal(outcome.result.resources.length, 2);
      assert.deepEqual(
        outcome.result.resources.map((resource) => resource.result.status),
        ['orphaned', 'orphaned'],
      );
      assert.equal(
        outcome.result.resources.every(
          (resource) =>
            resource.result.failureMessage ===
            'Runtime restarted without a live shell process handle',
        ),
        true,
      );
    } finally {
      await composition.close();
    }
  });
});

test('production Skill catalog resolves a Graph child durable tool surface', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const parent = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const child = await createClaimedGraphChild({
      root,
      parentSessionId: parent.id,
      suffix: 'c',
      stores,
      prompt: 'inspect the child Skill catalog',
    });
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const outcome = await composition.handlers['skill.catalog.invocable.query'](
        {
          kind: 'start',
          target: { kind: 'session', sessionId: child.request.targetSessionId },
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'graph-child-skill-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal(outcome.result.kind, 'page');
    } finally {
      await composition.close();
    }
  });
});

test('new Full Access Plan Skill previews use the mutating tool surface', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const skillDirectory = join(root, '.agents', 'skills', 'write-preview');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      [
        '---',
        'name: Write Preview',
        'description: Requires the Write tool.',
        'required-tools: [Write]',
        '---',
        '# Write Preview',
        '',
      ].join('\n'),
    );

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const connection = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'new-session-skill-client',
        principal: 'local_os_user' as const,
        acquireResidency: () => ({ release() {} }),
      };
      const query = (permissionMode: 'ask' | 'bypass') =>
        composition.handlers['skill.catalog.invocable.query'](
          {
            kind: 'start',
            target: {
              kind: 'new_session',
              context: { workspace: { kind: 'host_path', path: root } },
              collaborationMode: 'plan',
              permissionMode,
            },
          },
          connection,
        );

      const managed = await query('ask');
      assert.equal(managed.ok, true);
      if (!managed.ok || managed.result.kind !== 'page') return;
      assert.equal(
        managed.result.items.some((item) => item.id === 'write-preview'),
        false,
      );

      const fullAccess = await query('bypass');
      assert.equal(fullAccess.ok, true);
      if (!fullAccess.ok || fullAccess.result.kind !== 'page') return;
      assert.equal(
        fullAccess.result.items.some((item) => item.id === 'write-preview'),
        true,
      );
    } finally {
      await composition.close();
    }
  });
});

test('Skill capability previews omit unavailable Tavily search surfaces', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    for (const [id, requiredTool] of [
      ['web-search-preview', 'WebSearch'],
      ['web-research-preview', 'web_research'],
    ] as const) {
      const skillDirectory = join(root, '.agents', 'skills', id);
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(
        join(skillDirectory, 'SKILL.md'),
        [
          '---',
          `name: ${id}`,
          `description: Requires ${requiredTool}.`,
          `required-tools: [${requiredTool}]`,
          '---',
          `# ${id}`,
          '',
        ].join('\n'),
      );
    }

    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'skill-preview-model',
        name: 'Skill preview model',
        providerType: 'ollama',
        enabled: true,
        enabledModelIds: ['fake-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    const fetch = await policy.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') return;
    const fetched = await policy.operations.completeModelFetch(fetch.ticket, {
      models: [{ id: 'fake-model' }],
      source: 'fetched',
      fetchedAt: Date.now(),
    });
    assert.equal(fetched.kind, 'committed');
    if (fetched.kind !== 'committed') return;
    const defaultTarget = await policy.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: fetched.snapshot.revision,
      target: { connectionId: connection.connectionId, modelId: 'fake-model' },
    });
    assert.equal(defaultTarget.kind, 'committed');
    const policySnapshot = await policy.runtimePolicy.getSnapshot();
    const webSearchEnabled = await policy.runtimePolicy.mutate({
      expectedRevision: policySnapshot.revision,
      operation: {
        kind: 'set_web_search',
        value: { enabled: true, defaultProvider: 'tavily' },
      },
    });
    assert.equal(webSearchEnabled.kind, 'committed');
    assert.equal(
      (await policy.operations.resolveExecutionConnection(connection.slug)).kind,
      'ready',
    );

    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: connection.slug,
      model: 'fake-model',
      permissionMode: 'bypass',
    });
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner), {
      bootstrapRuntimePolicy: false,
    });
    try {
      await composition.recover();
      const connectionContext = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'web-search-skill-preview-client',
        principal: 'local_os_user' as const,
        acquireResidency: () => ({ release() {} }),
      };
      const query = (target: 'session' | 'new_session') =>
        composition.handlers['skill.catalog.invocable.query'](
          {
            kind: 'start',
            target:
              target === 'session'
                ? { kind: 'session', sessionId: session.id }
                : {
                    kind: 'new_session',
                    context: { workspace: { kind: 'host_path', path: root } },
                    collaborationMode: 'agent',
                    permissionMode: 'bypass',
                  },
          },
          connectionContext,
        );

      for (const target of ['session', 'new_session'] as const) {
        const outcome = await query(target);
        assert.equal(outcome.ok, true);
        if (!outcome.ok || outcome.result.kind !== 'page') continue;
        assert.equal(
          outcome.result.items.some(
            (item) => item.id === 'web-search-preview' || item.id === 'web-research-preview',
          ),
          false,
        );
      }
    } finally {
      await composition.close();
    }
  });
});

test('production composition validates graph stop before aborting a claimed child', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const claims = createAgentGraphControlStore(root);
    const parent = await stores.sessionStore.create({
      cwd: root,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const completedPrompt = 'execute the canonical claimed graph activation';
    const completed = await createClaimedGraphChild({
      root,
      parentSessionId: parent.id,
      suffix: 'a',
      stores,
      prompt: completedPrompt,
    });
    const completedClaim = (await claims.claimAgentGraphIntent(completed.request)).claim;
    const abortedFixture = await createClaimedGraphChild({
      root,
      parentSessionId: parent.id,
      suffix: 'e',
      stores,
      prompt: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    const abortedClaim = (await claims.claimAgentGraphIntent(abortedFixture.request)).claim;
    claims.close();
    const { composition, manager } = await createCapturedExecutionComposition(owner);
    let journeyError: unknown;
    try {
      const first = await manager.runClaimedAgentGraphIntent({
        claimStore: claims,
        intent: completed.intent,
        graphId: completedClaim.graphId,
        intentId: completedClaim.intentId,
        prompt: completedPrompt,
      });
      assert.equal(first.status, 'completed');

      const admission = await stores.agentRunStore.readRootTurnAdmission(
        completedClaim.targetSessionId,
        completedClaim.targetTurnId,
      );
      assert.ok(admission);
      assert.ok(admission.userMessageId);
      assert.deepEqual(admission.execution, graphExecutionDescriptor(completedClaim));
      assert.deepEqual(admission.normalizedInput, { text: completedPrompt });

      const retry = await manager.runClaimedAgentGraphIntent({
        claimStore: claims,
        intent: completed.intent,
        graphId: completedClaim.graphId,
        intentId: completedClaim.intentId,
        prompt: completedPrompt,
      });
      assert.deepEqual(
        {
          claimId: retry.claimId,
          childSessionId: retry.childSessionId,
          turnId: retry.turnId,
          runId: retry.runId,
          status: retry.status,
          summary: retry.summary,
        },
        {
          claimId: first.claimId,
          childSessionId: first.childSessionId,
          turnId: first.turnId,
          runId: first.runId,
          status: first.status,
          summary: first.summary,
        },
      );
      const retriedAdmission = await stores.agentRunStore.readRootTurnAdmission(
        completedClaim.targetSessionId,
        completedClaim.targetTurnId,
      );
      assert.equal(retriedAdmission?.userMessageId, admission.userMessageId);
      await assertUniqueGraphExecutionFacts(stores, completedClaim, admission.userMessageId);

      const abort = new AbortController();
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const aborting = manager.runClaimedAgentGraphIntent({
        claimStore: claims,
        intent: abortedFixture.intent,
        graphId: abortedClaim.graphId,
        intentId: abortedClaim.intentId,
        prompt: FAKE_ASK_USER_QUESTION_PROMPT,
        abortSignal: abort.signal,
        onReady: ready,
      });
      await started;
      const clientContext = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'graph-stop-client',
        principal: 'local_os_user' as const,
        acquireResidency: () => ({ release() {} }),
      };
      const invalidStop = await composition.handlers['agent.graph.stop'](
        {
          rootSessionId: abortedClaim.targetSessionId,
          expectedGraphId: abortedClaim.graphId,
        },
        clientContext,
      );
      assert.equal(invalidStop.ok, false);
      if (invalidStop.ok) return;
      assert.equal(invalidStop.error.code, 'operation_conflict');
      const stillActive = await composition.handlers['turn.query'](
        {
          sessionId: abortedClaim.targetSessionId,
          turnId: abortedClaim.targetTurnId,
        },
        clientContext,
      );
      assert.equal(stillActive.ok, true);
      if (!stillActive.ok) return;
      assert.equal(['completed', 'failed', 'cancelled'].includes(stillActive.result.status), false);
      abort.abort();
      const aborted = await aborting;
      assert.equal(aborted.status, 'cancelled');

      const abortedAdmission = await stores.agentRunStore.readRootTurnAdmission(
        abortedClaim.targetSessionId,
        abortedClaim.targetTurnId,
      );
      assert.ok(abortedAdmission?.userMessageId);
      assert.deepEqual(abortedAdmission?.execution, graphExecutionDescriptor(abortedClaim));
      const abortedRun = await stores.agentRunStore.readRun(
        abortedClaim.targetSessionId,
        abortedClaim.targetRunId,
      );
      assert.equal(abortedRun.status, 'cancelled');
      await assertUniqueGraphExecutionFacts(
        stores,
        abortedClaim,
        abortedAdmission.userMessageId,
        'run_cancelled',
      );
      assert.equal(
        (
          await stores.agentRunStore.readRun(
            completedClaim.targetSessionId,
            completedClaim.targetRunId,
          )
        ).status,
        'completed',
      );
    } catch (error) {
      journeyError = error;
      throw error;
    } finally {
      try {
        await composition.close();
      } catch (closeError) {
        if (journeyError !== undefined) {
          throw new AggregateError(
            [journeyError, closeError],
            'Claimed graph journey and composition close both failed',
          );
        }
        throw closeError;
      }
    }
  });
});

function compositionContext(owner: InteractiveRootOwner) {
  return {
    owner,
    hostEpoch: 'execution-composition-test',
    acquireResidency: () => ({ release() {} }),
    retainUntilProcessExit: () => undefined,
    requestDrain: () => undefined,
  };
}

function shellRunRecord(
  sessionId: string,
  shellRunId: string,
  status: 'starting' | 'running',
): ShellRunRecord {
  return {
    shellRunId,
    sessionId,
    sourceTurnId: `turn-${shellRunId}`,
    sourceToolCallId: `tool-${shellRunId}`,
    cwd: '/workspace',
    command: 'sleep 60',
    status,
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
}

/**
 * Writes one session whose durable header says `backend: 'fake'`.
 *
 * Nothing in this build can write that value, so the row goes in underneath the
 * session writer: create a normal row through the real store, then rewrite the
 * persisted backend the way an older build left it on disk. The database
 * filename is `OPERATIONAL_STATE_DATABASE_NAME` in `@maka/storage`, which the
 * package does not export.
 */
async function seedLegacyFakeBackendSession(
  root: string,
  owner: InteractiveRootOwner,
): Promise<string> {
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const { id: sessionId } = await stores.sessionStore.create({
    cwd: root,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
  });

  const legacy = new DatabaseSync(join(root, 'runtime.sqlite'));
  try {
    const row = legacy
      .prepare(`SELECT payload_json FROM session_metadata WHERE session_id = ?`)
      .get(sessionId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    payload.backend = 'fake';
    legacy
      .prepare(`UPDATE session_metadata SET payload_json = ?, backend = ? WHERE session_id = ?`)
      .run(JSON.stringify(payload), 'fake', sessionId);
  } finally {
    legacy.close();
  }
  return sessionId;
}

async function createCapturedExecutionComposition(owner: InteractiveRootOwner): Promise<{
  composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>;
  manager: SessionManager;
}> {
  const originalRecover = SessionManager.prototype.recoverInterruptedSessionsStrict;
  let manager: SessionManager | undefined;
  SessionManager.prototype.recoverInterruptedSessionsStrict = async function (stores) {
    manager = this;
    return originalRecover.call(this, stores);
  };
  try {
    // The production composition no longer registers a test backend of its
    // own; the deterministic one arrives through the same `primaryBackendFactory`
    // seam the Desktop E2E run uses.
    const composition = await createExecutionRuntimeHostComposition(
      compositionContext(owner),
      {},
      { primaryBackendFactory: (backendContext) => new FakeBackend(backendContext) },
    );
    await composition.recover();
    if (!manager) throw new Error('Production execution composition did not construct Runtime');
    return { composition, manager };
  } finally {
    SessionManager.prototype.recoverInterruptedSessionsStrict = originalRecover;
  }
}

async function createClaimedGraphChild(input: {
  root: string;
  parentSessionId: string;
  suffix: string;
  stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
  prompt: string;
}): Promise<{ request: AgentGraphIntentClaimRequest; intent: AgentGraphRunnableIntent }> {
  const turnId = `graph-turn-${input.suffix}`;
  const runId = `graph-run-${input.suffix}`;
  const child = await input.stores.sessionStore.createSubagent({
    cwd: input.root,
    name: `Graph operator ${input.suffix}`,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'explore',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    subagentParent: {
      kind: 'subagent',
      parentSessionId: input.parentSessionId,
      spawnedBy: {
        parentRunId: `parent-run-${input.suffix}`,
        parentTurnId: `parent-turn-${input.suffix}`,
        toolCallId: `graph-tool-${input.suffix}`,
      },
      lifecycle: 'foreground',
    },
    subagentRuntime: {
      schemaVersion: 1,
      definitionVersion: LOCAL_READ_AGENT_DEFINITION.definitionVersion,
      agentId: LOCAL_READ_AGENT_DEFINITION.id,
      agentName: LOCAL_READ_AGENT_DEFINITION.name,
      profile: LOCAL_READ_AGENT_DEFINITION.profile,
      systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
      toolNames: [...LOCAL_READ_AGENT_DEFINITION.tools],
      categoryPolicy: {},
      permissionCeiling: 'ask',
    },
    subagentSpawn: {
      schemaVersion: 1,
      requestFingerprint: input.suffix.repeat(64),
      initialTurnId: turnId,
      initialRunId: runId,
    },
  });
  assert.equal(child.created, true);
  const intent: AgentGraphRunnableIntent = {
    schemaVersion: 1,
    intentId: `graph_intent_${input.suffix.repeat(32)}`,
    graphId: `graph-${input.suffix}`,
    readinessContextFingerprint: `sha256:${nextHex(input.suffix).repeat(64)}`,
    policyFingerprint: `sha256:${nextHex(nextHex(input.suffix)).repeat(64)}`,
    readinessId: `readiness-${input.suffix}`,
    operatorId: LOCAL_READ_AGENT_DEFINITION.id,
    targetSessionId: child.header.id,
    policyKind: 'map',
    triggerRouteIds: [`route-${input.suffix}`],
    triggerRecordIds: [`record-${input.suffix}`],
  };
  return {
    intent,
    request: {
      schemaVersion: 1,
      claimId: `graph_claim_${input.suffix.repeat(32)}`,
      graphId: intent.graphId,
      intentId: intent.intentId,
      intentFingerprint: fingerprintAgentGraphRunnableIntent({
        intent,
        executionInput: { prompt: input.prompt },
      }),
      readinessContextFingerprint: intent.readinessContextFingerprint,
      targetOperatorId: LOCAL_READ_AGENT_DEFINITION.id,
      targetSessionId: child.header.id,
      targetTurnId: turnId,
      targetRunId: runId,
    },
  };
}

function graphExecutionDescriptor(claim: AgentGraphIntentClaim) {
  return {
    kind: 'claimed_agent_graph_intent' as const,
    claim,
    agentId: LOCAL_READ_AGENT_DEFINITION.id,
    agentName: LOCAL_READ_AGENT_DEFINITION.name,
  };
}

function lifecycleUsageRecord() {
  return {
    id: 'usage_after_composition_drain',
    providerId: 'openai',
    modelId: 'gpt-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
    costUsd: 0.001,
    latencyMs: 100,
    status: 'success',
    date: '2026-07-30',
    ts: Date.UTC(2026, 6, 30),
    startedAt: Date.UTC(2026, 6, 30) - 100,
  } as Parameters<
    Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>['telemetry']['recordLlmCall']
  >[0];
}

async function assertUniqueGraphExecutionFacts(
  stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>,
  claim: AgentGraphIntentClaim,
  userMessageId: string,
  expectedTerminal: 'run_completed' | 'run_cancelled' = 'run_completed',
): Promise<void> {
  const [runs, messages, runEvents, runtimeEvents] = await Promise.all([
    stores.agentRunStore.listSessionRuns(claim.targetSessionId),
    stores.sessionStore.readMessages(claim.targetSessionId),
    stores.agentRunStore.readEvents(claim.targetSessionId, claim.targetRunId),
    stores.runtimeEventStore.readImmutableRuntimeEvents(claim.targetSessionId, claim.targetRunId),
  ]);
  assert.deepEqual(
    runs.filter((run) => run.turnId === claim.targetTurnId).map((run) => run.runId),
    [claim.targetRunId],
  );
  assert.deepEqual(
    messages
      .filter((message) => message.type === 'user' && message.turnId === claim.targetTurnId)
      .map((message) => message.id),
    [userMessageId],
  );
  assert.equal(runEvents.filter((event) => event.type === 'run_started').length, 1);
  assert.equal(runEvents.filter((event) => event.type === expectedTerminal).length, 1);
  assert.equal(
    runtimeEvents.filter(
      (event) => event.status === (expectedTerminal === 'run_cancelled' ? 'aborted' : 'completed'),
    ).length,
    1,
  );
}

function nextHex(value: string): string {
  const code = Number.parseInt(value, 16);
  return ((code + 1) % 16).toString(16);
}

async function withCompositionRoot(
  run: (fixture: {
    root: string;
    owner: NonNullable<Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>>;
  }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-execution-composition-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire composition test root');
  try {
    await run({ root, owner });
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
