import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AgentRunHeader, RuntimeEvent } from '@maka/core';
import { createAgentRunStore, createRuntimeEventStore } from '../agent-run-store.js';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';
import {
  exportRuntimeEventsToJsonl,
  importLegacyRuntimeEventJsonlTree,
  importRuntimeEventsFromJsonl,
  openRuntimeEventPersistence,
} from '../runtime-event-transfer.js';

describe('runtime event JSONL compatibility transfer', () => {
  it('imports a legacy runtime tree idempotently into the SQLite canonical store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-runtime-import-'));
    const legacy = createRuntimeEventStore(root);
    const sqlite = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      const runs = createAgentRunStore(root);
      await runs.createRun(runHeader());
      await runs.createRun(runHeader({ runId: 'run-2', invocationId: 'run-2', turnId: 'turn-2' }));
      await legacy.appendRuntimeEvent('session-1', 'run-1', runtimeEvent('event-1'));
      await legacy.appendRuntimeEvent('session-1', 'run-1', runtimeEvent('event-2', { ts: 2 }));
      await legacy.appendRuntimeEvent(
        'session-1',
        'run-2',
        runtimeEvent('event-3', {
          invocationId: 'run-2',
          runId: 'run-2',
          turnId: 'turn-2',
          ts: 3,
        }),
      );
      await appendFile(
        join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-events.jsonl'),
        `${JSON.stringify(
          runtimeEvent('event-4', {
            ts: 4,
            content: undefined,
            actions: {
              permissionRequest: {
                requestId: 'pr-1',
                toolUseId: 'tc-1',
                toolName: 'Bash',
                category: 'shell_unsafe',
                reason: 'shell_dangerous',
                args: { command: 'rm foo' },
              },
            } as never,
          }),
        )}\n`,
      );

      const first = await importLegacyRuntimeEventJsonlTree({
        workspaceRoot: root,
        destination: sqlite,
      });
      const second = await importLegacyRuntimeEventJsonlTree({
        workspaceRoot: root,
        destination: sqlite,
      });

      assert.deepEqual(first, {
        filesScanned: 2,
        eventsRead: 4,
        eventsImported: 4,
        eventsExisting: 0,
      });
      assert.deepEqual(second, {
        filesScanned: 0,
        eventsRead: 0,
        eventsImported: 0,
        eventsExisting: 0,
      });
      assert.deepEqual(
        (await sqlite.readSessionRuntimeEvents('session-1')).map((event) => event.id),
        ['event-1', 'event-2', 'event-3', 'event-4'],
      );
      const importedRequest = (await sqlite.readRuntimeEvents('session-1', 'run-1')).at(-1)?.actions
        ?.permissionRequest;
      assert.equal(importedRequest?.kind, 'tool_permission');
      assert.equal(importedRequest?.rememberForTurnAllowed, false);
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('skips legacy stream partial snapshots left in the JSONL log instead of failing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-runtime-import-partial-'));
    const legacy = createRuntimeEventStore(root);
    const sqlite = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
    try {
      await createAgentRunStore(root).createRun(runHeader());
      await legacy.appendRuntimeEvent('session-1', 'run-1', runtimeEvent('event-1'));
      await legacy.appendRuntimeEvent('session-1', 'run-1', runtimeEvent('event-2', { ts: 2 }));
      // Older versions wrote stream partial snapshots straight into the JSONL
      // log; current code diverts them to .partial files. Simulate the legacy row.
      const jsonlPath = join(
        root,
        'sessions',
        'session-1',
        'runs',
        'run-1',
        'runtime-events.jsonl',
      );
      const legacyStreamPartial = {
        ...runtimeEvent('partial-thinking', {
          ts: 3,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'thinking', text: 'interrupted thought' },
        }),
        unexpectedField: true,
      };
      const partialRowWithStatus = runtimeEvent('partial-terminal', {
        ts: 4,
        partial: true,
        role: 'model',
        author: 'agent',
        status: 'failed',
        actions: { endInvocation: true },
      });
      await appendFile(
        jsonlPath,
        `${JSON.stringify(legacyStreamPartial)}\n${JSON.stringify(partialRowWithStatus)}\n`,
        'utf8',
      );

      const report = await importLegacyRuntimeEventJsonlTree({
        workspaceRoot: root,
        destination: sqlite,
      });

      assert.deepEqual(report, {
        filesScanned: 1,
        eventsRead: 3,
        eventsImported: 3,
        eventsExisting: 0,
      });
      assert.deepEqual(
        (await sqlite.readImmutableRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
        ['event-1', 'event-2', 'partial-terminal'],
      );
    } finally {
      sqlite.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('round-trips explicit JSONL export without creating a second live writer', async () => {
    const sqlite = createSqliteRuntimeStore(':memory:');
    try {
      const events = [runtimeEvent('event-1'), runtimeEvent('event-2', { ts: 2 })];
      for (const event of events) await sqlite.appendRuntimeEvent('session-1', 'run-1', event);

      const jsonl = await exportRuntimeEventsToJsonl(sqlite, 'session-1', 'run-1');
      const destination = createSqliteRuntimeStore(':memory:');
      try {
        const report = await importRuntimeEventsFromJsonl({
          jsonl,
          sessionId: 'session-1',
          runId: 'run-1',
          destination,
        });
        assert.deepEqual(report, { eventsRead: 2, eventsImported: 2, eventsExisting: 0 });
        assert.deepEqual(await destination.readRuntimeEvents('session-1', 'run-1'), events);
      } finally {
        destination.close();
      }
    } finally {
      sqlite.close();
    }
  });

  it('rejects malformed rows and cross-run identity drift', async () => {
    const sqlite = createSqliteRuntimeStore(':memory:');
    try {
      await assert.rejects(
        importRuntimeEventsFromJsonl({
          jsonl: '{not-json}\n',
          sessionId: 'session-1',
          runId: 'run-1',
          destination: sqlite,
        }),
        /Invalid RuntimeEvent JSONL line 1/,
      );
      await assert.rejects(
        importRuntimeEventsFromJsonl({
          jsonl: `${JSON.stringify(runtimeEvent('event-1', { runId: 'other-run' }))}\n`,
          sessionId: 'session-1',
          runId: 'run-1',
          destination: sqlite,
        }),
        /identity mismatch/i,
      );
      await assert.rejects(
        importRuntimeEventsFromJsonl({
          jsonl: `${JSON.stringify(runtimeEvent('partial-1', { partial: true }))}\n`,
          sessionId: 'session-1',
          runId: 'run-1',
          destination: sqlite,
        }),
        /partial RuntimeEvent/i,
      );
    } finally {
      sqlite.close();
    }
  });

  it('selects exactly one canonical writer and imports before returning SQLite mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-runtime-persistence-'));
    const legacy = createRuntimeEventStore(root);
    try {
      await createAgentRunStore(root).createRun(runHeader());
      await legacy.appendRuntimeEvent('session-1', 'run-1', runtimeEvent('event-1'));

      const opened = await openRuntimeEventPersistence({
        workspaceRoot: root,
        sqliteCanonical: true,
      });
      try {
        assert.equal(opened.kind, 'sqlite');
        assert.ok(opened.runtimeCommitStore);
        assert.strictEqual(opened.runtimeEventStore, opened.runtimeCommitStore);
        assert.equal(opened.importReport?.eventsImported, 1);
        assert.deepEqual(
          (await opened.runtimeEventStore.readRuntimeEvents('session-1', 'run-1')).map(
            (event) => event.id,
          ),
          ['event-1'],
        );
        await opened.runtimeEventStore.appendRuntimeEvent(
          'session-1',
          'run-1',
          runtimeEvent('sqlite-only-event', { ts: 2 }),
        );
      } finally {
        opened.close();
      }

      const stickyCanonical = await openRuntimeEventPersistence({
        workspaceRoot: root,
        sqliteCanonical: false,
      });
      try {
        assert.equal(stickyCanonical.kind, 'sqlite');
        assert.deepEqual(
          (await stickyCanonical.runtimeEventStore.readRuntimeEvents('session-1', 'run-1')).map(
            (event) => event.id,
          ),
          ['event-1', 'sqlite-only-event'],
        );
      } finally {
        stickyCanonical.close();
      }

      const legacyOnly = await openRuntimeEventPersistence({
        workspaceRoot: join(root, 'legacy-only'),
        sqliteCanonical: false,
      });
      assert.equal(legacyOnly.kind, 'jsonl');
      assert.equal(legacyOnly.runtimeCommitStore, undefined);
      legacyOnly.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function runtimeEvent(id: string, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id,
    invocationId: 'run-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: id },
    ...overrides,
  };
}

function runHeader(overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  return {
    runId: 'run-1',
    invocationId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/workspace',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
