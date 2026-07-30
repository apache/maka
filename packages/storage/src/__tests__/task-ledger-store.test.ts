import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TASK_LEDGER_MAX_TASKS, TASK_SUBJECT_MAX_CHARS } from '@maka/core/task-ledger';
import { createTaskLedgerStore } from '../task-ledger-store.js';

const SESSION_ID = 'sess-abc';

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'maka-task-ledger-'));
}

function tasksFilePath(root: string): string {
  return join(root, 'sessions', SESSION_ID, 'tasks.json');
}

function taskEventsFilePath(root: string): string {
  return join(root, 'sessions', SESSION_ID, 'task-events.jsonl');
}

describe('TaskLedgerStore', () => {
  it('creates tasks with normalized subjects and pending status, returning created tasks and the new total', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);

    const { created, total } = await store.create(SESSION_ID, [
      { subject: '  写测试 ' },
      { subject: '实现功能' },
    ]);
    assert.equal(created.length, 2);
    assert.equal(created[0]?.subject, '写测试');
    assert.equal(created[0]?.status, 'pending');
    assert.equal(typeof created[0]?.id, 'string');
    assert.equal(created[0]?.createdAt, created[0]?.updatedAt);
    assert.equal(total, 2);

    const reloaded = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.equal(reloaded.length, 2);
    assert.deepEqual(
      reloaded.map((t) => t.subject),
      ['写测试', '实现功能'],
    );

    const raw = JSON.parse(await readFile(tasksFilePath(root), 'utf8')) as unknown[];
    assert.equal(raw.length, 2);
    const eventLines = (await readFile(taskEventsFilePath(root), 'utf8')).trim().split('\n');
    assert.equal(eventLines.length, 2);
    const firstEvent = JSON.parse(eventLines[0]!) as { type: string; refs?: unknown };
    assert.equal(firstEvent.type, 'task_created');
  });

  it('persists mutation context refs in task events', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);

    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'context task' }], {
      runId: 'run-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      source: 'tool',
      actor: 'main_agent',
    });
    assert.ok(task);
    await store.update(SESSION_ID, task.id, { status: 'in_progress' });
    await store.update(
      SESSION_ID,
      task.id,
      { status: 'completed', completionEvidence: 'node --test passed' },
      {
        runId: 'run-2',
        turnId: 'turn-2',
        toolCallId: 'call-2',
        source: 'tool',
        actor: 'main_agent',
      },
    );

    const events = (await readFile(taskEventsFilePath(root), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            refs?: { runId?: string; turnId?: string; toolCallId?: string };
            source?: string;
            actor?: string;
          },
      );
    assert.equal(events[0]?.type, 'task_created');
    assert.equal(events[0]?.refs?.runId, 'run-1');
    assert.equal(events[0]?.refs?.turnId, 'turn-1');
    assert.equal(events[0]?.refs?.toolCallId, 'call-1');
    assert.equal(events[0]?.source, 'tool');
    assert.equal(events[0]?.actor, 'main_agent');
    assert.equal(events[1]?.type, 'task_started');
    assert.equal(events[2]?.type, 'task_completed');
    assert.equal(events[2]?.refs?.runId, 'run-2');
    assert.equal(events[2]?.refs?.turnId, 'turn-2');
    assert.equal(events[2]?.refs?.toolCallId, 'call-2');
  });

  it('clears stale evidence when tasks leave evidence-bearing statuses', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'evidence lifecycle' }]);
    assert.ok(task);

    await store.update(SESSION_ID, task.id, { status: 'in_progress' });
    const blocked = await store.update(SESSION_ID, task.id, {
      status: 'blocked',
      blockedReason: 'waiting for user input',
    });
    assert.equal(blocked.updated.blockedReason, 'waiting for user input');

    const resumed = await store.update(SESSION_ID, task.id, { status: 'in_progress' });
    assert.equal(resumed.updated.status, 'in_progress');
    assert.equal(resumed.updated.blockedReason, undefined);

    const completed = await store.update(SESSION_ID, task.id, {
      status: 'completed',
      completionEvidence: 'node --test passed',
    });
    assert.equal(completed.updated.completionEvidence, 'node --test passed');

    const reopened = await store.update(SESSION_ID, task.id, {
      status: 'in_progress',
      explicitReopen: true,
    });
    assert.equal(reopened.updated.status, 'in_progress');
    assert.equal(reopened.updated.completionEvidence, undefined);

    const listed = await store.list(SESSION_ID);
    const reloaded = listed.find((t) => t.id === task.id);
    assert.equal(reloaded?.blockedReason, undefined);
    assert.equal(reloaded?.completionEvidence, undefined);
  });

  it('requires explicit reopen and records task_reopened events', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'reopen task' }]);
    assert.ok(task);

    await store.update(SESSION_ID, task.id, { status: 'in_progress' });
    await store.update(SESSION_ID, task.id, {
      status: 'completed',
      completionEvidence: 'verified',
    });
    await assert.rejects(
      () => store.update(SESSION_ID, task.id, { status: 'in_progress' }),
      /Invalid task status transition/,
    );

    const reopened = await store.update(SESSION_ID, task.id, {
      status: 'in_progress',
      explicitReopen: true,
    });
    assert.equal(reopened.updated.status, 'in_progress');
    assert.equal('explicitReopen' in reopened.updated, false);

    const events = (await readFile(taskEventsFilePath(root), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            previousStatus?: string;
            nextStatus?: string;
            task?: Record<string, unknown>;
          },
      );
    const reopenEvent = events.at(-1);
    assert.equal(reopenEvent?.type, 'task_reopened');
    assert.equal(reopenEvent?.previousStatus, 'completed');
    assert.equal(reopenEvent?.nextStatus, 'in_progress');
    assert.equal(reopenEvent?.task?.completionEvidence, undefined);
  });

  it('lists an empty ledger when the file does not exist', async () => {
    const root = await tempRoot();
    assert.deepEqual(await createTaskLedgerStore(root).list(SESSION_ID), []);
  });

  it('gets one task by id and classifies resume trust on recovery reads', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'recover me' }]);
    assert.ok(task);
    await store.update(SESSION_ID, task.id, { status: 'in_progress' });

    const plain = await store.get(SESSION_ID, task.id);
    assert.equal(plain?.resumeTrust, undefined);
    const classified = await store.get(SESSION_ID, task.id, { classifyResumeTrust: true });
    assert.equal(classified?.resumeTrust, 'stale');
    assert.equal(await store.get(SESSION_ID, 'missing'), undefined);
  });

  it('updates a task status and subject, returning the updated task and the new total', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [task],
      total: afterCreate,
    } = await store.create(SESSION_ID, [{ subject: '原始' }, { subject: '其他' }]);
    assert.ok(task);
    assert.equal(afterCreate, 2);

    const { updated, total } = await store.update(SESSION_ID, task.id, {
      status: 'in_progress',
      subject: '改过',
    });
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.subject, '改过');
    assert.ok(updated.updatedAt >= task.updatedAt);
    assert.equal(updated.createdAt, task.createdAt);
    // total is the post-mutation count from inside the write queue; re-read the
    // ledger to verify the updated task landed and the file matches it.
    assert.equal(total, 2);
    const all = await store.list(SESSION_ID);
    assert.deepEqual(
      all.find((t) => t.id === task.id),
      updated,
    );

    const reloaded = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.deepEqual(reloaded, all);
  });

  it('rejects an unknown task id, an empty patch, an invalid status, and empty create drafts', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'x' }]);
    assert.ok(task);

    await assert.rejects(
      () =>
        store.update(SESSION_ID, 'no-such-id', { status: 'completed', completionEvidence: 'done' }),
      /No such task/,
    );
    await assert.rejects(() => store.update(SESSION_ID, task.id, {}), /at least one/);
    await assert.rejects(
      () => store.update(SESSION_ID, task.id, { status: 'bogus' }),
      /Task status/,
    );
    await store.update(SESSION_ID, task.id, { status: 'in_progress' });
    await assert.rejects(
      () => store.update(SESSION_ID, task.id, { status: 'completed' }),
      /completionEvidence/,
    );
    await assert.rejects(() => store.create(SESSION_ID, []), /at least one/);
    await assert.rejects(() => store.create(SESSION_ID, [{ subject: '   ' }]), /empty/);
  });

  it('does not rewrite the file when the update target does not exist', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await store.create(SESSION_ID, [{ subject: 'x' }]);
    const before = await readFile(tasksFilePath(root), 'utf8');

    await assert.rejects(
      () =>
        store.update(SESSION_ID, 'no-such-id', { status: 'completed', completionEvidence: 'done' }),
      /No such task/,
    );

    const after = await readFile(tasksFilePath(root), 'utf8');
    assert.equal(after, before);
  });

  it('degrades a corrupt ledger to an empty list on the render path', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(tasksFilePath(root), 'not json at all', 'utf8');
    assert.deepEqual(await createTaskLedgerStore(root).list(SESSION_ID), []);
  });

  it('refuses to mutate over a corrupt ledger and leaves the file untouched', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    const store = createTaskLedgerStore(root);

    for (const corrupt of ['not json at all', '{"not":"an array"}']) {
      await writeFile(tasksFilePath(root), corrupt, 'utf8');
      await assert.rejects(
        () => store.create(SESSION_ID, [{ subject: '新任务' }]),
        /corrupt; refusing to overwrite/,
      );
      await assert.rejects(
        () =>
          store.update(SESSION_ID, 'any-id', { status: 'completed', completionEvidence: 'done' }),
        /corrupt; refusing to overwrite/,
      );
      // The mutation must not have replaced the damaged file with fn([]).
      assert.equal(await readFile(tasksFilePath(root), 'utf8'), corrupt);
      // The render path still degrades to empty so turns are not wedged.
      assert.deepEqual(await store.list(SESSION_ID), []);
    }
  });

  it('treats a corrupt task event log as authoritative corruption', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await store.create(SESSION_ID, [{ subject: 'x' }]);
    await writeFile(taskEventsFilePath(root), 'not json\n', 'utf8');

    const rendered = await store.list(SESSION_ID);
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0]?.subject, 'x');
    assert.equal(rendered[0]?.resumeTrust, 'untrusted');
    await assert.rejects(
      () => store.create(SESSION_ID, [{ subject: 'new' }]),
      /task event ledger|Invalid task event/i,
    );
  });

  it('degrades to an empty render ledger when corrupt task events have no readable cache', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(taskEventsFilePath(root), 'not json\n', 'utf8');
    await writeFile(tasksFilePath(root), '{not json', 'utf8');

    const store = createTaskLedgerStore(root);
    assert.deepEqual(await store.list(SESSION_ID), []);
    await assert.rejects(
      () => store.create(SESSION_ID, [{ subject: 'new' }]),
      /task event ledger|Invalid task event/i,
    );
    assert.equal(await readFile(taskEventsFilePath(root), 'utf8'), 'not json\n');
    assert.equal(await readFile(tasksFilePath(root), 'utf8'), '{not json');
  });

  it('drops malformed entries while keeping valid ones', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(
      tasksFilePath(root),
      JSON.stringify([
        { id: 'good', subject: '有效', status: 'pending', createdAt: 1, updatedAt: 1 },
        { id: 'bad-status', subject: 'x', status: 'nope', createdAt: 1, updatedAt: 1 },
        { subject: 'no id', status: 'pending', createdAt: 1, updatedAt: 1 },
        'garbage',
      ]),
      'utf8',
    );
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.id, 'good');
  });

  it('re-applies subject normalization on read: discards overlong/blank/empty subjects and normalizes whitespace', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(
      tasksFilePath(root),
      JSON.stringify([
        {
          id: 'overlong',
          subject: 'X'.repeat(TASK_SUBJECT_MAX_CHARS + 1),
          status: 'pending',
          createdAt: 1,
          updatedAt: 1,
        },
        { id: 'blank', subject: '   ', status: 'pending', createdAt: 1, updatedAt: 1 },
        { id: 'empty', subject: '', status: 'pending', createdAt: 1, updatedAt: 1 },
        {
          id: 'whitespace',
          subject: 'a\t\tb\n\nc   d',
          status: 'pending',
          createdAt: 1,
          updatedAt: 1,
        },
        { id: 'good', subject: '有效', status: 'pending', createdAt: 1, updatedAt: 1 },
      ]),
      'utf8',
    );
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    // overlong/blank/empty subjects are discarded per-record; good + whitespace survive.
    assert.equal(
      tasks.length,
      2,
      `expected 2 surviving tasks, got ${tasks.length}: ${JSON.stringify(tasks.map((t) => t.id))}`,
    );
    const ids = tasks.map((t) => t.id);
    assert.ok(ids.includes('good'));
    assert.ok(ids.includes('whitespace'));
    // whitespace subject is normalized (collapse + trim) on read.
    const ws = tasks.find((t) => t.id === 'whitespace');
    assert.equal(
      ws?.subject,
      'a b c d',
      `expected normalized subject, got ${JSON.stringify(ws?.subject)}`,
    );
  });

  it('treats an over-cap tasks.json as corrupt: list() rejects and mutate stays fail-closed', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    const overcap = Array.from({ length: TASK_LEDGER_MAX_TASKS + 1 }, (_, i) => ({
      id: `cap-${i}`,
      subject: `任务${i}`,
      status: 'pending',
      createdAt: i,
      updatedAt: i,
    }));
    await writeFile(tasksFilePath(root), JSON.stringify(overcap), 'utf8');
    const store = createTaskLedgerStore(root);
    // render path degrades to an empty list (readForRender try/catches the over-cap file)
    assert.deepEqual(await store.list(SESSION_ID), []);
    // mutate path stays fail-closed: a create must not silently truncate-and-overwrite the over-cap file
    await assert.rejects(
      () => store.create(SESSION_ID, [{ subject: '新任务' }]),
      /corrupt|limit|exceed/i,
    );
    // the file is left untouched (not truncated)
    const raw = await readFile(tasksFilePath(root), 'utf8');
    assert.equal(JSON.parse(raw).length, TASK_LEDGER_MAX_TASKS + 1);
  });

  it('treats a tasks.json with duplicate ids as corrupt: render degrades to empty, mutate stays fail-closed', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(
      tasksFilePath(root),
      JSON.stringify([
        { id: 'dup-id', subject: 'first', status: 'pending', createdAt: 1, updatedAt: 1 },
        { id: 'dup-id', subject: 'second', status: 'pending', createdAt: 2, updatedAt: 2 },
        { id: 'uniq', subject: 'unique', status: 'pending', createdAt: 3, updatedAt: 3 },
      ]),
      'utf8',
    );
    const store = createTaskLedgerStore(root);
    // render path degrades to empty: no duplicate id reaches the turn tail
    // (two same-id tasks would be indistinguishable to the model).
    assert.deepEqual(await store.list(SESSION_ID), []);
    // mutate path stays fail-closed: an update must not silently keep both
    // dups and rewrite a "half-correct" file (first updated, second stale).
    await assert.rejects(
      () => store.update(SESSION_ID, 'dup-id', { status: 'completed', completionEvidence: 'done' }),
      /corrupt|duplicate|ambiguous/i,
    );
    const raw = await readFile(tasksFilePath(root), 'utf8');
    assert.equal(JSON.parse(raw).length, 3, 'file must be left untouched');
  });

  it('rejects non-finite timestamps (1e999 -> Infinity) so they cannot round-trip to null and vanish', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    // raw JSON with 1e999, which JSON.parse reads as Infinity; JSON.stringify of
    // Infinity is null, so writing via JSON.stringify could not reproduce this --
    // only a hand-edited or legacy file carries it.
    await writeFile(
      tasksFilePath(root),
      '[{"id":"good","subject":"ok","status":"pending","createdAt":1,"updatedAt":1},' +
        '{"id":"bad-ts","subject":"inf","status":"pending","createdAt":1e999,"updatedAt":1e999}]',
      'utf8',
    );
    const store = createTaskLedgerStore(root);
    // read path drops the non-finite record (render degrades to the valid one)
    assert.deepEqual(
      (await store.list(SESSION_ID)).map((t) => t.id),
      ['good'],
    );
    // mutate path: a create must not round-trip the Infinity to null
    await store.create(SESSION_ID, [{ subject: 'after' }]);
    const raw = JSON.parse(await readFile(tasksFilePath(root), 'utf8')) as Array<{
      createdAt: unknown;
      updatedAt: unknown;
    }>;
    for (const r of raw) {
      assert.equal(
        Number.isFinite(r.createdAt),
        true,
        `createdAt must stay finite after mutate, got ${JSON.stringify(r)}`,
      );
      assert.equal(
        Number.isFinite(r.updatedAt),
        true,
        `updatedAt must stay finite after mutate, got ${JSON.stringify(r)}`,
      );
    }
  });

  it('rejects records with unsafe ids (newline, overlong, empty, whitespace) on read', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(
      tasksFilePath(root),
      JSON.stringify([
        { id: 'abc\nINJECTED', subject: '换行id', status: 'pending', createdAt: 1, updatedAt: 1 },
        { id: 'X'.repeat(5000), subject: '超长id', status: 'pending', createdAt: 2, updatedAt: 2 },
        { id: '', subject: '空id', status: 'pending', createdAt: 3, updatedAt: 3 },
        { id: 'has space', subject: '带空格id', status: 'pending', createdAt: 4, updatedAt: 4 },
        { id: 'good-id', subject: '正常', status: 'pending', createdAt: 5, updatedAt: 5 },
      ]),
      'utf8',
    );
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.equal(
      tasks.length,
      1,
      `expected only the safe-id record to survive, got ${JSON.stringify(tasks.map((t) => t.id))}`,
    );
    assert.equal(tasks[0]?.id, 'good-id');
  });

  it('rejects ids that are not redaction-stable tokens (tag-like, angle brackets, quotes, parens, secret-shaped); keeps UUID-shaped and simple ids', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(
      tasksFilePath(root),
      JSON.stringify([
        {
          id: 'a<task-ledger/>b',
          subject: 'tag-like',
          status: 'pending',
          createdAt: 1,
          updatedAt: 1,
        },
        { id: 'a>b', subject: 'gt', status: 'pending', createdAt: 2, updatedAt: 2 },
        { id: 'a"b', subject: 'quote', status: 'pending', createdAt: 3, updatedAt: 3 },
        { id: 'a(b)', subject: 'paren', status: 'pending', createdAt: 4, updatedAt: 4 },
        { id: 'a=b', subject: 'equals', status: 'pending', createdAt: 5, updatedAt: 5 },
        // secret-shaped stable tokens: pass the charset/length rules but redactSecrets
        // would render them as (id: [redacted]), so TaskUpdate on [redacted] would miss.
        {
          id: 'ghp_abcdefghijklmnopqrstuvwxyz',
          subject: 'ghp',
          status: 'pending',
          createdAt: 6,
          updatedAt: 6,
        },
        { id: 'sk-abcdefghi', subject: 'sk', status: 'pending', createdAt: 7, updatedAt: 7 },
        { id: 'a'.repeat(40), subject: 'hex40', status: 'pending', createdAt: 8, updatedAt: 8 },
        {
          id: 'AIza' + 'X'.repeat(24),
          subject: 'aiza',
          status: 'pending',
          createdAt: 9,
          updatedAt: 9,
        },
        {
          id: '123e4567-e89b-12d3-a456-426614174000',
          subject: 'uuid',
          status: 'pending',
          createdAt: 10,
          updatedAt: 10,
        },
        { id: 'good-id_1:2', subject: 'simple', status: 'pending', createdAt: 11, updatedAt: 11 },
      ]),
      'utf8',
    );
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    const ids = tasks.map((t) => t.id);
    // Only ids that are stable tokens AND survive redaction (so the rendered id
    // equals the stored id) survive; a TaskUpdate on the rendered id then hits.
    assert.deepEqual(ids, ['123e4567-e89b-12d3-a456-426614174000', 'good-id_1:2']);
  });

  it('rejects an oversized batch before generating tasks or writing (existing ledger unchanged)', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await store.create(SESSION_ID, [{ subject: 'seed' }]);
    const before = await readFile(tasksFilePath(root), 'utf8');
    // Oversized batch with an invalid draft in the middle: without an early
    // batch-size check, normalizeCreateTaskInput runs during `drafts.map` and
    // throws the per-draft subject error; with the early check, the batch is
    // rejected as a batch before any draft is touched or any id is generated.
    const batch = Array.from({ length: TASK_LEDGER_MAX_TASKS + 5 }, (_, i) =>
      i === 2 ? { subject: '' } : { subject: `任务${i}` },
    );
    await assert.rejects(() => store.create(SESSION_ID, batch), /cap|limit|exceed|batch/i);
    const after = await readFile(tasksFilePath(root), 'utf8');
    assert.equal(after, before, 'existing ledger must be unchanged');
  });

  it('rejects an unsafe session id', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await assert.rejects(() => store.list('../escape'), /Invalid session id/);
  });

  it('serializes concurrent creates without losing writes', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    await Promise.all([
      store.create(SESSION_ID, [{ subject: 'a' }]),
      store.create(SESSION_ID, [{ subject: 'b' }]),
      store.create(SESSION_ID, [{ subject: 'c' }]),
    ]);
    const tasks = await store.list(SESSION_ID);
    assert.equal(tasks.length, 3);
    assert.deepEqual(new Set(tasks.map((t) => t.subject)), new Set(['a', 'b', 'c']));
  });

  it('enforces the total-task cap inside the write queue without touching the file', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const fill = Array.from({ length: TASK_LEDGER_MAX_TASKS }, (_, i) => ({ subject: `t${i}` }));
    await store.create(SESSION_ID, fill);

    // Over-cap create must reject with a clear total-count message...
    await assert.rejects(
      () => store.create(SESSION_ID, [{ subject: 'overflow' }]),
      new RegExp(`limited to ${TASK_LEDGER_MAX_TASKS} tasks total`),
    );

    // ...and must not have written anything: the ledger is unchanged.
    const tasks = await store.list(SESSION_ID);
    assert.equal(tasks.length, TASK_LEDGER_MAX_TASKS);
    assert.equal(
      tasks.some((t) => t.subject === 'overflow'),
      false,
    );

    // Completing tasks does not free capacity: the cap is on total count.
    const first = tasks[0];
    assert.ok(first);
    await store.update(SESSION_ID, first.id, { status: 'in_progress' });
    await store.update(SESSION_ID, first.id, { status: 'completed', completionEvidence: 'done' });
    await assert.rejects(
      () => store.create(SESSION_ID, [{ subject: 'still-over' }]),
      /hard runaway guard/,
    );

    // A single batch larger than the cap rejects at the front door (per-batch
    // cap, before generating ids), so the ledger stays empty.
    const freshStore = createTaskLedgerStore(await tempRoot());
    const oversizedBatch = Array.from({ length: TASK_LEDGER_MAX_TASKS + 1 }, (_, i) => ({
      subject: `b${i}`,
    }));
    await assert.rejects(() => freshStore.create(SESSION_ID, oversizedBatch), /per-batch cap/);
    assert.deepEqual(await freshStore.list(SESSION_ID), []);
  });

  it('persists blocked failed completed evidence fields and resumeTrust when present on disk', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [first, second, third],
    } = await store.create(SESSION_ID, [
      { subject: 'blocked task' },
      { subject: 'failed task' },
      { subject: 'completed task' },
    ]);
    assert.ok(first);
    assert.ok(second);
    assert.ok(third);

    await store.update(SESSION_ID, first.id, { status: 'in_progress' });
    await store.update(SESSION_ID, second.id, { status: 'in_progress' });
    await store.update(SESSION_ID, third.id, { status: 'in_progress' });
    await store.update(SESSION_ID, first.id, {
      status: 'blocked',
      blockedReason: 'waiting for user approval',
    });
    await store.update(SESSION_ID, second.id, {
      status: 'failed',
      failureReason: 'test suite cannot pass',
    });
    await store.update(SESSION_ID, third.id, {
      status: 'completed',
      completionEvidence: 'npm test passed',
    });

    const reloaded = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.equal(
      reloaded.find((t) => t.id === first.id)?.blockedReason,
      'waiting for user approval',
    );
    assert.equal(reloaded.find((t) => t.id === second.id)?.failureReason, 'test suite cannot pass');
    assert.equal(reloaded.find((t) => t.id === third.id)?.completionEvidence, 'npm test passed');

    const events = (await readFile(taskEventsFilePath(root), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'task_created',
        'task_created',
        'task_created',
        'task_started',
        'task_started',
        'task_started',
        'task_blocked',
        'task_failed',
        'task_completed',
      ],
    );
  });

  it('prefers task event replay over a stale tasks.json cache', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'event source' }]);
    assert.ok(task);
    await writeFile(tasksFilePath(root), JSON.stringify([], null, 2), 'utf8');
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.subject, 'event source');
  });

  it('falls back to legacy tasks.json when no task event log exists', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(
      tasksFilePath(root),
      JSON.stringify([
        {
          id: 'legacy-task',
          subject: 'old task',
          status: 'pending',
          createdAt: 1,
          updatedAt: 1,
          owner: {
            actor: 'child_agent',
            sessionId: 'child-session',
            agentId: 'local-read',
            runId: 'child-run',
            turnId: 'child-turn',
          },
        },
      ]),
      'utf8',
    );
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.deepEqual(
      tasks.map((t) => t.id),
      ['legacy-task'],
    );
    assert.deepEqual(tasks[0]?.owner, {
      actor: 'child_agent',
      sessionId: 'child-session',
      agentId: 'local-read',
      runId: 'child-run',
      turnId: 'child-turn',
    });
  });

  it('imports legacy tasks into the event log before appending the first create', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(
      tasksFilePath(root),
      JSON.stringify([
        { id: 'legacy-task', subject: 'old task', status: 'pending', createdAt: 1, updatedAt: 1 },
      ]),
      'utf8',
    );
    const store = createTaskLedgerStore(root);

    const {
      created: [created],
      total,
    } = await store.create(SESSION_ID, [{ subject: 'new task' }]);
    assert.ok(created);
    assert.equal(total, 2);

    const reloaded = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.deepEqual(
      reloaded.map((t) => t.id),
      ['legacy-task', created.id],
    );

    const events = (await readFile(taskEventsFilePath(root), 'utf8'))
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { type: string; taskId: string; source?: string; actor?: string },
      );
    assert.deepEqual(
      events.map((event) => event.type),
      ['task_imported', 'task_created'],
    );
    assert.equal(events[0]?.taskId, 'legacy-task');
    assert.equal(events[0]?.source, 'import');
    assert.equal(events[0]?.actor, 'system');
    assert.equal(events[1]?.taskId, created.id);
  });

  it('imports legacy tasks into the event log before appending the first update', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(
      tasksFilePath(root),
      JSON.stringify([
        { id: 'legacy-task', subject: 'old task', status: 'pending', createdAt: 1, updatedAt: 1 },
      ]),
      'utf8',
    );
    const store = createTaskLedgerStore(root);

    const { updated, total } = await store.update(SESSION_ID, 'legacy-task', {
      status: 'in_progress',
    });
    assert.equal(updated.status, 'in_progress');
    assert.equal(total, 1);

    const reloaded = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.deepEqual(
      reloaded.map((t) => [t.id, t.status]),
      [['legacy-task', 'in_progress']],
    );

    const events = (await readFile(taskEventsFilePath(root), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; taskId: string });
    assert.deepEqual(
      events.map((event) => event.type),
      ['task_imported', 'task_started'],
    );
    assert.equal(events[0]?.taskId, 'legacy-task');
    assert.equal(events[1]?.taskId, 'legacy-task');
  });

  it('keeps legacy completed and cancelled tasks readable without evidence', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(
      tasksFilePath(root),
      JSON.stringify([
        {
          id: 'legacy-completed',
          subject: 'old done',
          status: 'completed',
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'legacy-cancelled',
          subject: 'old cancelled',
          status: 'cancelled',
          createdAt: 2,
          updatedAt: 2,
        },
      ]),
      'utf8',
    );
    const tasks = await createTaskLedgerStore(root).list(SESSION_ID);
    assert.deepEqual(
      tasks.map((t) => t.id),
      ['legacy-completed', 'legacy-cancelled'],
    );
  });

  it('can retry a failed task as pending without poisoning event replay', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'retry me' }]);
    assert.ok(task);
    await store.update(SESSION_ID, task.id, { status: 'in_progress' });
    await store.update(SESSION_ID, task.id, { status: 'failed', failureReason: 'test failed' });

    const retried = await store.update(SESSION_ID, task.id, { status: 'pending' });
    assert.equal(retried.updated.status, 'pending');
    assert.equal(retried.updated.failureReason, undefined);

    const reloadedStore = createTaskLedgerStore(root);
    assert.equal((await reloadedStore.get(SESSION_ID, task.id))?.status, 'pending');
    const {
      created: [afterRetry],
      total,
    } = await reloadedStore.create(SESSION_ID, [{ subject: 'after retry' }]);
    assert.ok(afterRetry);
    assert.equal(total, 2);

    const events = (await readFile(taskEventsFilePath(root), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; taskId: string });
    assert.deepEqual(
      events.map((event) => event.type),
      ['task_created', 'task_started', 'task_failed', 'task_reopened', 'task_created'],
    );
  });

  it('rejects blocked failed and completed updates without required evidence without rewriting', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'x' }]);
    assert.ok(task);
    await store.update(SESSION_ID, task.id, { status: 'in_progress' });
    const before = await readFile(tasksFilePath(root), 'utf8');

    await assert.rejects(
      () => store.update(SESSION_ID, task.id, { status: 'blocked' }),
      /blockedReason/,
    );
    await assert.rejects(
      () => store.update(SESSION_ID, task.id, { status: 'failed' }),
      /failureReason/,
    );
    await assert.rejects(
      () => store.update(SESSION_ID, task.id, { status: 'completed' }),
      /completionEvidence/,
    );
    assert.equal(await readFile(tasksFilePath(root), 'utf8'), before);
  });

  it('allocates stable hierarchical keys under concurrent creates and resolves key or UUID', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [parent],
    } = await store.create(SESSION_ID, [{ subject: 'parent' }]);
    assert.ok(parent);
    const batches = await Promise.all([
      store.create(SESSION_ID, [{ subject: 'child a', parentId: parent.key }]),
      store.create(SESSION_ID, [{ subject: 'child b', parentId: parent.id }]),
      store.create(SESSION_ID, [{ subject: 'child c', parentId: parent.key }]),
    ]);
    const children = batches.flatMap((batch) => batch.created);
    assert.deepEqual(new Set(children.map((task) => task.key)), new Set(['T1.1', 'T1.2', 'T1.3']));
    assert.equal(
      (await store.get(SESSION_ID, 'T1.2'))?.id,
      children.find((task) => task.key === 'T1.2')?.id,
    );
    await store.update(SESSION_ID, children[0]!.key, { status: 'in_progress' });
    assert.equal((await store.get(SESSION_ID, children[0]!.id))?.status, 'in_progress');
    assert.deepEqual(
      (await createTaskLedgerStore(root).list(SESSION_ID)).map((task) => task.key),
      ['T1', 'T1.1', 'T1.2', 'T1.3'],
    );
  });

  it('rejects completing a parent with active descendants', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [parent],
    } = await store.create(SESSION_ID, [{ subject: 'parent' }]);
    assert.ok(parent);
    await store.create(SESSION_ID, [{ subject: 'child', parentId: parent.key }]);
    await store.update(SESSION_ID, parent.id, { status: 'in_progress' });
    await assert.rejects(
      () =>
        store.update(SESSION_ID, parent.key, {
          status: 'completed',
          completionEvidence: 'parent done',
        }),
      /descendant T1\.1 is pending/,
    );
  });

  it('atomically self-claims only available tasks and limits one task per child turn', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [first, second],
    } = await store.create(
      SESSION_ID,
      [{ subject: 'first shared task' }, { subject: 'second shared task' }],
      { actor: 'main_agent', runId: 'lead-run', turnId: 'lead-turn' },
    );
    assert.ok(first && second);
    const owner = {
      actor: 'child_agent' as const,
      agentId: 'expert:code-review:correctness-reviewer',
      turnId: 'child-turn',
    };
    const scope = { parentRunId: 'lead-run' };
    const claimed = await store.claimAvailable(SESSION_ID, first.id, owner, scope, {
      actor: 'child_agent',
      source: 'tool',
    });
    assert.equal(claimed.updated.status, 'in_progress');
    assert.deepEqual(claimed.updated.owner, owner);
    assert.equal(
      (await store.claimAvailable(SESSION_ID, first.id, owner, scope)).updated.id,
      first.id,
    );
    await assert.rejects(
      () => store.claimAvailable(SESSION_ID, second.id, owner, scope),
      /already owns task T1/,
    );
  });

  it('refuses self-claim of unowned tasks or tasks shared by another lead run', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [unowned],
    } = await store.create(SESSION_ID, [{ subject: 'ordinary task' }]);
    const {
      created: [olderRun],
    } = await store.create(SESSION_ID, [{ subject: 'older team task' }], {
      actor: 'main_agent',
      runId: 'older-lead-run',
      turnId: 'older-lead-turn',
    });
    assert.ok(unowned && olderRun);
    const owner = { actor: 'child_agent' as const, agentId: 'agent-a', turnId: 'turn-a' };
    const scope = { parentRunId: 'lead-run' };
    await assert.rejects(
      () => store.claimAvailable(SESSION_ID, unowned.id, owner, scope),
      /not shared by parent run/,
    );
    await assert.rejects(
      () => store.claimAvailable(SESSION_ID, olderRun.id, owner, scope),
      /not shared by parent run/,
    );
  });

  it('resolves concurrent self-claim races inside the write queue', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'shared' }], {
      actor: 'main_agent',
      runId: 'lead-run',
      turnId: 'lead-turn',
    });
    assert.ok(task);
    const outcomes = await Promise.allSettled([
      store.claimAvailable(
        SESSION_ID,
        task.id,
        { actor: 'child_agent', agentId: 'agent-a', turnId: 'turn-a' },
        { parentRunId: 'lead-run' },
      ),
      store.claimAvailable(
        SESSION_ID,
        task.id,
        { actor: 'child_agent', agentId: 'agent-b', turnId: 'turn-b' },
        { parentRunId: 'lead-run' },
      ),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    assert.equal((await store.get(SESSION_ID, task.id))?.status, 'in_progress');
  });

  it('backfills old JSONL fields and persists compatibility events on the next write', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    const legacyTask = {
      id: 'legacy-event-task',
      subject: 'old event',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    };
    await writeFile(
      taskEventsFilePath(root),
      `${JSON.stringify({
        eventId: 'event-1',
        type: 'task_created',
        ts: 1,
        sessionId: SESSION_ID,
        taskId: legacyTask.id,
        nextStatus: legacyTask.status,
        task: legacyTask,
      })}\n`,
      'utf8',
    );
    const store = createTaskLedgerStore(root);
    assert.equal((await store.get(SESSION_ID, legacyTask.id))?.key, 'T1');
    await store.update(SESSION_ID, 'T1', { status: 'in_progress' });
    const events = (await readFile(taskEventsFilePath(root), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((item) => item.type),
      ['task_created', 'task_updated', 'task_started'],
    );
    assert.equal(events[1].task.key, 'T1');
    assert.equal((await createTaskLedgerStore(root).get(SESSION_ID, 'T1'))?.id, legacyTask.id);
  });

  it('fails closed when a persisted child key skips a level under its parent', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    const parent = {
      id: 'parent',
      key: 'T1',
      subject: 'parent',
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    };
    const child = {
      id: 'child',
      key: 'T1.1.1',
      parentId: parent.id,
      subject: 'child',
      status: 'pending',
      createdAt: 2,
      updatedAt: 2,
    };
    const events = [parent, child].map((task, index) => ({
      eventId: `event-${index}`,
      type: 'task_created',
      ts: task.createdAt,
      sessionId: SESSION_ID,
      taskId: task.id,
      nextStatus: task.status,
      task,
    }));
    await writeFile(
      taskEventsFilePath(root),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
      'utf8',
    );
    const store = createTaskLedgerStore(root);
    assert.deepEqual(await store.list(SESSION_ID), []);
    await assert.rejects(
      () => store.update(SESSION_ID, parent.id, { status: 'in_progress' }),
      /projection diagnostics|does not belong under parent key/,
    );
  });

  it('filters archived terminal tasks while preserving compatibility defaults', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'sessions', SESSION_ID), { recursive: true });
    await writeFile(
      tasksFilePath(root),
      JSON.stringify([
        {
          id: 'old-completed',
          subject: 'old done',
          status: 'completed',
          createdAt: 1,
          updatedAt: 2,
          endedAt: 2,
          completionEvidence: 'done',
        },
        { id: 'active-task', subject: 'active', status: 'pending', createdAt: 3, updatedAt: 3 },
      ]),
      'utf8',
    );
    const store = createTaskLedgerStore(root);
    assert.deepEqual(
      (await store.list(SESSION_ID)).map((task) => task.key),
      ['T1', 'T2'],
    );
    assert.deepEqual(
      (await store.list(SESSION_ID, { includeArchived: false, now: 10 ** 12 })).map(
        (task) => task.key,
      ),
      ['T2'],
    );
    assert.deepEqual(
      (await store.list(SESSION_ID, { includeTerminal: false })).map((task) => task.key),
      ['T2'],
    );
  });

  it('notifies subscribers and preserves child outcomes without auto-completing success', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const changes: Array<{ sessionId: string; taskIds: string[] }> = [];
    const unsubscribe = store.subscribe((event) => changes.push(event));
    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'delegated' }]);
    assert.ok(task);
    const owner = { actor: 'child_agent' as const, agentId: 'local-read', turnId: 'child-turn' };
    await store.claim(SESSION_ID, task.key, owner);
    await store.settleAgentOutcome(SESSION_ID, task.id, {
      status: 'completed',
      owner: { ...owner, runId: 'child-run' },
      reason: 'child reported success',
    });
    const settled = await store.get(SESSION_ID, task.id);
    assert.equal(settled?.status, 'in_progress');
    assert.equal(settled?.owner?.runId, 'child-run');
    await assert.rejects(
      () => store.claim(SESSION_ID, task.id, { ...owner, turnId: 'other-child-turn' }),
      /already claimed/,
    );
    unsubscribe();
    assert.equal(changes.length, 3);
    assert.equal(
      changes.every((event) => event.sessionId === SESSION_ID),
      true,
    );
  });

  it('persists failed and cancelled child outcomes with stable owner refs', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [failedTask, cancelledTask],
    } = await store.create(SESSION_ID, [{ subject: 'fails' }, { subject: 'cancels' }]);
    assert.ok(failedTask && cancelledTask);
    const failedOwner = {
      actor: 'child_agent' as const,
      agentId: 'local-read',
      turnId: 'failed-turn',
    };
    const cancelledOwner = {
      actor: 'child_agent' as const,
      agentId: 'local-read',
      turnId: 'cancelled-turn',
    };
    await store.claim(SESSION_ID, failedTask.id, failedOwner);
    await store.claim(SESSION_ID, cancelledTask.id, cancelledOwner);
    await store.settleAgentOutcome(SESSION_ID, failedTask.id, {
      status: 'failed',
      owner: { ...failedOwner, runId: 'failed-run' },
      reason: 'child tests failed',
    });
    await store.settleAgentOutcome(SESSION_ID, cancelledTask.id, {
      status: 'cancelled',
      owner: { ...cancelledOwner, runId: 'cancelled-run' },
      reason: 'parent stopped',
    });

    const reloaded = await createTaskLedgerStore(root).list(SESSION_ID);
    const failed = reloaded.find((task) => task.id === failedTask.id);
    const cancelled = reloaded.find((task) => task.id === cancelledTask.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.failureReason, 'child tests failed');
    assert.equal(failed?.owner?.runId, 'failed-run');
    assert.equal(typeof failed?.endedAt, 'number');
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(cancelled?.owner?.runId, 'cancelled-run');
    assert.equal(typeof cancelled?.endedAt, 'number');
  });

  it('records a generic child user wait without inventing a permission reason', async () => {
    const root = await tempRoot();
    const store = createTaskLedgerStore(root);
    const {
      created: [task],
    } = await store.create(SESSION_ID, [{ subject: 'needs input' }]);
    assert.ok(task);
    const owner = {
      actor: 'child_agent' as const,
      agentId: 'local-read',
      turnId: 'waiting-turn',
    };
    await store.claim(SESSION_ID, task.id, owner);
    await store.settleAgentOutcome(SESSION_ID, task.id, {
      status: 'waiting_for_user',
      owner: { ...owner, runId: 'waiting-run' },
    });

    const waiting = await createTaskLedgerStore(root).get(SESSION_ID, task.id);
    assert.equal(waiting?.status, 'blocked');
    assert.equal(waiting?.blockedReason, 'Child agent is waiting for user input');
    assert.equal(waiting?.owner?.runId, 'waiting-run');
  });
});
