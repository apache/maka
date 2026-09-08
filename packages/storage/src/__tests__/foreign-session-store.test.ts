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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FOREIGN_SESSION_DIGEST_MAX_READ_BYTES,
  FOREIGN_SESSION_SCAN_MAX_AGE_MS,
  FOREIGN_SESSION_SCAN_MAX_SESSIONS,
  type ForeignSessionSummary,
} from '@maka/core/foreign-session';
import {
  codexCwdSqlVariants,
  createForeignSessionStore,
  isClaudeCodeImportEnabled,
  isCodexImportEnabled,
  isOpenCodeImportEnabled,
} from '../foreign-session-store.js';

const NOW = Date.now();

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'maka-foreign-'));
}

function claudeLine(record: Record<string, unknown>): string {
  return JSON.stringify(record) + '\n';
}

async function seedClaudeSession(
  home: string,
  options: {
    id: string;
    cwd: string;
    aiTitle?: string;
    sidechain?: boolean;
    userText?: string;
    assistantText?: string;
    filePath?: string;
    /** Bytes of leading summary noise before the cwd-bearing record. */
    leadingPadBytes?: number;
  },
): Promise<string> {
  const dir = join(home, '.claude', 'projects', options.cwd.replace(/\//g, '-'));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${options.id}.jsonl`);
  const lines = [
    claudeLine({ type: 'mode', sessionId: options.id, mode: 'default' }),
    ...(options.leadingPadBytes
      ? [
          claudeLine({
            type: 'summary',
            sessionId: options.id,
            summary: 'x'.repeat(options.leadingPadBytes),
          }),
        ]
      : []),
    claudeLine({
      type: 'user',
      sessionId: options.id,
      cwd: options.cwd,
      gitBranch: 'main',
      isSidechain: options.sidechain ?? false,
      timestamp: new Date(NOW - 60_000).toISOString(),
      message: { role: 'user', content: options.userText ?? 'do the thing' },
    }),
    claudeLine({
      type: 'assistant',
      sessionId: options.id,
      cwd: options.cwd,
      isSidechain: options.sidechain ?? false,
      timestamp: new Date(NOW - 30_000).toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: options.assistantText ?? 'done' },
          ...(options.filePath
            ? [{ type: 'tool_use', name: 'Edit', input: { file_path: options.filePath } }]
            : []),
        ],
      },
    }),
    'not valid json\n',
    ...(options.aiTitle
      ? [claudeLine({ type: 'ai-title', sessionId: options.id, aiTitle: options.aiTitle })]
      : []),
  ];
  await writeFile(path, lines.join(''), 'utf8');
  return path;
}

type CodexThreadSeed = {
  id: string;
  cwd: string;
  title?: string;
  updatedAtMs?: number;
  archived?: number;
  source?: string | null;
  rolloutRelPath?: string;
};

function seedCodexSqlite(home: string, threads: CodexThreadSeed[]): Promise<void> {
  return seedCodexSqliteGen(home, 3, threads);
}

async function seedCodexSqliteGen(
  home: string,
  gen: number,
  threads: CodexThreadSeed[],
): Promise<void> {
  const codexRoot = join(home, '.codex');
  await mkdir(join(codexRoot, 'sessions', '2026', '07', '18'), { recursive: true });
  const db = new DatabaseSync(join(codexRoot, `state_${gen}.sqlite`));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT,
    first_user_message TEXT, updated_at_ms INTEGER, git_branch TEXT,
    archived INTEGER DEFAULT 0, source TEXT DEFAULT 'cli'
  )`);
  const insert = db.prepare(
    'INSERT INTO threads (id, rollout_path, cwd, title, updated_at_ms, archived, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const t of threads) {
    const rollout = join(
      codexRoot,
      t.rolloutRelPath ?? `sessions/2026/07/18/rollout-1750000000000-${t.id}.jsonl`,
    );
    await writeFile(
      rollout,
      [
        JSON.stringify({
          type: 'session_meta',
          timestamp: new Date(NOW - 60_000).toISOString(),
          payload: { id: t.id, cwd: t.cwd, git: { branch: 'main' } },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'codex task' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'codex reply' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"rm -rf /"}' },
        }),
      ].join('\n') + '\n',
      'utf8',
    ).catch(() => {});
    insert.run(
      t.id,
      rollout,
      t.cwd,
      t.title ?? null,
      t.updatedAtMs ?? NOW - 60_000,
      t.archived ?? 0,
      t.source === undefined ? 'cli' : t.source,
    );
  }
  db.close();
}

type OpenCodeSessionSeed = {
  id: string;
  cwd: string;
  title?: string;
  parentId?: string | null;
  updatedAtMs?: number;
  userText?: string;
  assistantText?: string;
  filePath?: string;
  toolOutput?: string;
  thinking?: string;
};

async function seedOpenCodeDb(home: string, sessions: OpenCodeSessionSeed[]): Promise<string> {
  const root = join(home, '.local', 'share', 'opencode');
  await mkdir(root, { recursive: true });
  const dbPath = join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id text PRIMARY KEY, parent_id text, directory text NOT NULL, title text,
        time_created integer, time_updated integer, time_archived integer
      );
      CREATE TABLE message (
        id text PRIMARY KEY, session_id text NOT NULL,
        time_created integer NOT NULL, data text NOT NULL
      );
      CREATE TABLE part (
        id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
        time_created integer NOT NULL, data text NOT NULL
      );
    `);
    const insertSession = db.prepare(
      'INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertMessage = db.prepare(
      'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
    );
    const insertPart = db.prepare(
      'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
    );
    let n = 0;
    const nextId = (prefix: string): string => `${prefix}_${n++}`;
    for (const session of sessions) {
      const ts = session.updatedAtMs ?? NOW - 60_000;
      insertSession.run(
        session.id,
        session.parentId ?? null,
        session.cwd,
        session.title ?? session.id,
        ts,
        ts,
        null,
      );
      const userMsg = nextId('msg');
      const assistantMsg = nextId('msg');
      insertMessage.run(userMsg, session.id, ts, JSON.stringify({ role: 'user' }));
      insertMessage.run(assistantMsg, session.id, ts + 1, JSON.stringify({ role: 'assistant' }));
      insertPart.run(
        nextId('part'),
        userMsg,
        session.id,
        ts,
        JSON.stringify({ type: 'text', text: session.userText ?? 'opencode task' }),
      );
      if (session.thinking !== undefined) {
        insertPart.run(
          nextId('part'),
          assistantMsg,
          session.id,
          ts + 1,
          JSON.stringify({ type: 'reasoning', text: session.thinking }),
        );
      }
      insertPart.run(
        nextId('part'),
        assistantMsg,
        session.id,
        ts + 2,
        JSON.stringify({ type: 'text', text: session.assistantText ?? 'opencode reply' }),
      );
      insertPart.run(
        nextId('part'),
        assistantMsg,
        session.id,
        ts + 3,
        JSON.stringify({
          type: 'tool',
          tool: 'read',
          callID: nextId('call'),
          state: {
            status: 'completed',
            input: { filePath: session.filePath ?? '/repo/src/parser.ts' },
            output: session.toolOutput ?? 'TOOL_OUTPUT rm -rf / should not leak',
          },
        }),
      );
    }
  } finally {
    db.close();
  }
  return dbPath;
}

describe('foreign session store — enable flags', () => {
  it('defaults on, disabled by exactly "0"', () => {
    assert.equal(isClaudeCodeImportEnabled({}), true);
    assert.equal(isClaudeCodeImportEnabled({ MAKA_IMPORT_CLAUDE_CODE: '0' }), false);
    assert.equal(isCodexImportEnabled({ MAKA_IMPORT_CODEX: '1' }), true);
    assert.equal(isCodexImportEnabled({ MAKA_IMPORT_CODEX: '0' }), false);
    assert.equal(isOpenCodeImportEnabled({}), true);
    assert.equal(isOpenCodeImportEnabled({ MAKA_IMPORT_OPENCODE: '1' }), true);
    assert.equal(isOpenCodeImportEnabled({ MAKA_IMPORT_OPENCODE: '0' }), false);
  });

  it('reports only sources that are enabled AND present on disk', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.claude', 'projects'), { recursive: true });
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    assert.deepEqual(await store.availableSources(), ['claude-code']);
    const disabled = createForeignSessionStore({
      homeDir: home,
      env: { MAKA_IMPORT_CLAUDE_CODE: '0' },
    });
    assert.deepEqual(await disabled.availableSources(), []);
  });
});

describe('foreign session store — Claude scan', () => {
  it('lists sessions with title, cwd filter, and drops sidechains', async () => {
    const home = await tempHome();
    await seedClaudeSession(home, { id: 'aaa', cwd: '/repo/one', aiTitle: '修复登录 bug' });
    await seedClaudeSession(home, { id: 'bbb', cwd: '/repo/two' });
    await seedClaudeSession(home, { id: 'ccc', cwd: '/repo/one', sidechain: true });
    const store = createForeignSessionStore({ homeDir: home, env: {} });

    const all = await store.listSessions();
    assert.deepEqual(all.map((s) => s.id).sort(), ['aaa', 'bbb']);

    const filtered = await store.listSessions({ cwd: '/repo/one' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0]!.id, 'aaa');
    assert.equal(filtered[0]!.title, '修复登录 bug');
    assert.equal(filtered[0]!.source, 'claude-code');
    assert.equal(filtered[0]!.gitBranch, 'main');
  });

  it('sanitizes hostile titles at the scan boundary', async () => {
    const home = await tempHome();
    await seedClaudeSession(home, {
      id: 'evil',
      cwd: '/repo',
      aiTitle: 'safe\u202Etitle\u0007with sk-ant-api03-abcdefghijklmnop injected',
    });
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const [session] = await store.listSessions();
    assert.ok(session);
    assert.ok(!session.title.includes('\u202E'));
    assert.ok(!session.title.includes('\u0007'));
    assert.ok(!session.title.includes('sk-ant-api03-abcdefghijklmnop'), session.title);
  });

  it('caps the number of listed sessions', async () => {
    const home = await tempHome();
    for (let i = 0; i < FOREIGN_SESSION_SCAN_MAX_SESSIONS + 5; i++) {
      await seedClaudeSession(home, { id: `s${String(i).padStart(3, '0')}`, cwd: '/repo' });
    }
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const all = await store.listSessions();
    assert.equal(all.length, FOREIGN_SESSION_SCAN_MAX_SESSIONS);
  });

  it('finds cwd past the 4KB head via the adaptive window (does not drop the session)', async () => {
    const home = await tempHome();
    // 100KB of leading summary noise pushes the cwd-bearing user record far
    // past a fixed 4KB head — the adaptive read must still find it.
    await seedClaudeSession(home, {
      id: 'big',
      cwd: '/repo',
      leadingPadBytes: 100_000,
      aiTitle: '大会话',
    });
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const all = await store.listSessions();
    assert.deepEqual(
      all.map((s) => s.id),
      ['big'],
    );
    assert.equal(all[0]!.cwd, '/repo');
  });

  it('sanitizes and redacts cwd / gitBranch in the returned summary', async () => {
    const home = await tempHome();
    const dir = join(home, '.claude', 'projects', '-repo');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '0fb0463a-ec8e-4d50-896d-c825c3148ae7.jsonl'),
      claudeLine({
        type: 'user',
        // A cwd carrying a bidi override and a branch carrying a secret must
        // not reach a TUI consumer verbatim.
        cwd: '/repo' + '\u202E' + 'spoof',
        gitBranch: 'feat-AIzaSyA1234567890abcdefghijklmnop',
        isSidechain: false,
        message: { content: 'hi' },
      }),
      'utf8',
    );
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const [session] = await store.listSessions();
    assert.ok(session);
    assert.ok(!session.cwd.includes('\u202E'), 'bidi override must be stripped from summary cwd');
    assert.ok(
      !session.gitBranch!.includes('AIzaSyA1234567890abcdefghijklmnop'),
      'secret must be redacted from branch',
    );
  });

  it('drops a session whose transcript filename is not a safe id', async () => {
    const home = await tempHome();
    const dir = join(home, '.claude', 'projects', '-repo');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'has space.jsonl'),
      claudeLine({ type: 'user', cwd: '/repo', isSidechain: false, message: { content: 'hi' } }),
      'utf8',
    );
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    assert.deepEqual(
      (await store.listSessions()).map((s) => s.id),
      [],
    );
  });
});

describe('foreign session store — Codex scan', () => {
  it('includes POSIX-shaped SQL variants for a native Windows cwd', () => {
    const native = win32.join('C:\\', 'Users', 'me', 'project');
    const variants = codexCwdSqlVariants(native);
    assert.ok(variants.includes('C:/Users/me/project'));
    assert.ok(variants.includes('C:/Users/me/project/'));
  });

  it('lists threads from sqlite, dropping archived and foreign-source rows', async () => {
    const home = await tempHome();
    await seedCodexSqlite(home, [
      { id: 't1', cwd: '/repo', title: 'Codex 任务' },
      { id: 't2', cwd: '/repo', archived: 1 },
      { id: 't3', cwd: '/repo', source: 'exotic' },
      { id: 't4', cwd: '/elsewhere' },
    ]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const all = await store.listSessions();
    assert.deepEqual(all.map((s) => s.id).sort(), ['t1', 't4']);
    const filtered = await store.listSessions({ cwd: '/repo' });
    assert.deepEqual(
      filtered.map((s) => s.id),
      ['t1'],
    );
    assert.equal(filtered[0]!.title, 'Codex 任务');
  });

  it('lists atlas/chatgpt threads whose source is a JSON object', async () => {
    const home = await tempHome();
    await seedCodexSqlite(home, [
      { id: 'atl', cwd: '/repo', title: 'Atlas', source: '{"custom":"atlas"}' },
      { id: 'gpt', cwd: '/repo', title: 'ChatGPT', source: '{"custom":"chatgpt"}' },
      { id: 'bad', cwd: '/repo', source: '{"custom":"unknown"}' },
    ]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    assert.deepEqual((await store.listSessions()).map((s) => s.id).sort(), ['atl', 'gpt']);
  });

  it('routes every supported sqlite source shape through the shared gate', async () => {
    const home = await tempHome();
    await seedCodexSqlite(home, [
      { id: 'bare-exec', cwd: '/repo', source: 'exec' },
      { id: 'bare-atlas', cwd: '/repo', source: 'atlas' },
      { id: 'bare-chatgpt', cwd: '/repo', source: 'chatgpt' },
      { id: 'wrapped-cli', cwd: '/repo', source: '{ "custom": "cli" }' },
      { id: 'wrapped-vscode', cwd: '/repo', source: '{"custom":"vscode"}' },
      { id: 'legacy-null', cwd: '/repo', source: null },
      { id: 'unsupported', cwd: '/repo', source: '{"custom":"other"}' },
    ]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    assert.deepEqual((await store.listSessions()).map((session) => session.id).sort(), [
      'bare-atlas',
      'bare-chatgpt',
      'bare-exec',
      'legacy-null',
      'wrapped-cli',
      'wrapped-vscode',
    ]);
  });

  it('rejects rollout paths that escape ~/.codex', async () => {
    const home = await tempHome();
    const outside = join(home, 'outside.jsonl');
    await writeFile(
      outside,
      JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd: '/repo' } }),
      'utf8',
    );
    await seedCodexSqlite(home, [{ id: 'esc', cwd: '/repo', rolloutRelPath: '../outside.jsonl' }]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const all = await store.listSessions();
    assert.deepEqual(
      all.map((s) => s.id),
      [],
    );
  });

  it('applies the cwd filter in SQL so a LIMIT of newer other-project rows cannot hide it', async () => {
    const home = await tempHome();
    const threads = [];
    // 120 newer threads in /other, then one older thread in /target. If cwd
    // were filtered only after a LIMIT, the target row would be truncated away.
    for (let i = 0; i < 120; i++) {
      threads.push({
        id: `o${String(i).padStart(3, '0')}`,
        cwd: '/other',
        updatedAtMs: NOW - 1000 * i,
      });
    }
    threads.push({ id: 'target', cwd: '/target', title: 'the one', updatedAtMs: NOW - 10_000_000 });
    await seedCodexSqlite(home, threads);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const found = await store.listSessions({ cwd: '/target' });
    assert.deepEqual(
      found.map((s) => s.id),
      ['target'],
    );
  });

  it('matches a stored trailing-slash cwd against a caller path without one', async () => {
    const home = await tempHome();
    await seedCodexSqlite(home, [{ id: 'ts', cwd: '/target/', title: 'trailing slash' }]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    assert.deepEqual(
      (await store.listSessions({ cwd: '/target' })).map((s) => s.id),
      ['ts'],
    );
  });

  it('treats the first usable DB as authoritative: an all-archived newest gen does not resurface older rows', async () => {
    const home = await tempHome();
    // Newest gen (state_5) has only an archived thread; an older gen has an
    // active one. The archived-in-newest session must stay hidden.
    await seedCodexSqliteGen(home, 5, [{ id: 'archived-now', cwd: '/repo', archived: 1 }]);
    await seedCodexSqliteGen(home, 2, [{ id: 'stale-active', cwd: '/repo', title: 'old' }]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    assert.deepEqual(
      (await store.listSessions()).map((s) => s.id),
      [],
    );
  });

  it('descends to an older generation only when the newest DB lacks the threads schema', async () => {
    const home = await tempHome();
    await seedCodexSqliteGen(home, 2, [{ id: 'real', cwd: '/repo', title: 'real' }]);
    // Newest gen has no threads table → unusable → skip to gen 2.
    const codexRoot = join(home, '.codex');
    const badDb = new DatabaseSync(join(codexRoot, 'state_9.sqlite'));
    badDb.exec('CREATE TABLE other (x TEXT)');
    badDb.close();
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    assert.deepEqual(
      (await store.listSessions()).map((s) => s.id),
      ['real'],
    );
  });

  it('drops a thread whose rollout filename uuid does not match the row id', async () => {
    const home = await tempHome();
    // rollout file names a different session than the thread row claims.
    await seedCodexSqlite(home, [
      {
        id: 'realid',
        cwd: '/repo',
        rolloutRelPath: 'sessions/2026/07/18/rollout-1750000000000-otherid.jsonl',
      },
    ]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    assert.deepEqual(
      (await store.listSessions()).map((s) => s.id),
      [],
    );
  });

  it('falls back to the rollout walk when no sqlite exists', async () => {
    const home = await tempHome();
    const day = join(home, '.codex', 'sessions', '2026', '07', '18');
    await mkdir(day, { recursive: true });
    await writeFile(
      join(day, 'rollout-t9.jsonl'),
      [
        JSON.stringify({
          type: 'session_meta',
          timestamp: new Date(NOW - 60_000).toISOString(),
          payload: { id: 't9', cwd: '/repo' },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '走兜底路径' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const all = await store.listSessions();
    assert.equal(all.length, 1);
    assert.equal(all[0]!.id, 't9');
    assert.equal(all[0]!.title, '走兜底路径');
  });
});

describe('foreign session store — OpenCode scan', () => {
  it('declares the source only when the database file exists', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.local', 'share', 'opencode'), { recursive: true });
    const empty = createForeignSessionStore({ homeDir: home, env: {} });
    assert.deepEqual(await empty.availableSources(), []);
    await seedOpenCodeDb(home, [{ id: 'ses_visible', cwd: '/repo' }]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    assert.deepEqual(await store.availableSources(), ['opencode']);
  });

  it('hides the source when MAKA_IMPORT_OPENCODE is 0', async () => {
    const home = await tempHome();
    await seedOpenCodeDb(home, [{ id: 'ses_hidden', cwd: '/repo' }]);
    const store = createForeignSessionStore({
      homeDir: home,
      env: { MAKA_IMPORT_OPENCODE: '0' },
    });
    assert.deepEqual(await store.availableSources(), []);
    assert.deepEqual(await store.listSessions(), []);
  });

  it('lists parent sessions, filters by cwd, and skips child sessions', async () => {
    const home = await tempHome();
    await seedOpenCodeDb(home, [
      { id: 'ses_one', cwd: '/repo/one', title: '登录修复' },
      { id: 'ses_two', cwd: '/repo/two', title: 'other' },
      { id: 'ses_child', cwd: '/repo/one', title: 'subagent', parentId: 'ses_one' },
    ]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const all = await store.listSessions();
    assert.deepEqual(all.map((s) => s.id).sort(), ['ses_one', 'ses_two']);
    assert.equal(all.find((s) => s.id === 'ses_one')?.title, '登录修复');
    assert.equal(all.find((s) => s.id === 'ses_one')?.source, 'opencode');
    const filtered = await store.listSessions({ cwd: '/repo/one' });
    assert.deepEqual(
      filtered.map((s) => s.id),
      ['ses_one'],
    );
  });

  it('caps listed sessions at 50 and drops rows older than 30 days', async () => {
    const home = await tempHome();
    const sessions: OpenCodeSessionSeed[] = [];
    for (let i = 0; i < FOREIGN_SESSION_SCAN_MAX_SESSIONS + 5; i++) {
      sessions.push({
        id: `ses_r${String(i).padStart(3, '0')}`,
        cwd: '/repo',
        title: `recent ${i}`,
        updatedAtMs: NOW - i * 1000,
      });
    }
    sessions.push({
      id: 'ses_expired',
      cwd: '/repo',
      title: 'expired',
      updatedAtMs: NOW - FOREIGN_SESSION_SCAN_MAX_AGE_MS - 60_000,
    });
    await seedOpenCodeDb(home, sessions);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const all = await store.listSessions();
    assert.equal(all.length, FOREIGN_SESSION_SCAN_MAX_SESSIONS);
    assert.equal(all[0]!.id, 'ses_r000');
    assert.ok(!all.some((s) => s.id === 'ses_expired'));
    assert.ok(!all.some((s) => s.id === 'ses_r054'));
  });
});

describe('foreign session store — digest', () => {
  it('builds a digest with user/assistant text and file paths, dropping tool output', async () => {
    const home = await tempHome();
    await seedClaudeSession(home, {
      id: 'd1',
      cwd: '/repo',
      userText: '帮我修复解析器',
      assistantText: '已修复并补了测试',
      filePath: '/repo/src/parser.ts',
    });
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const [session] = await store.listSessions();
    assert.ok(session);
    const digest = await store.readDigest(session);
    assert.deepEqual(digest.userMessages, ['帮我修复解析器']);
    assert.deepEqual(digest.assistantTexts, ['已修复并补了测试']);
    assert.deepEqual(digest.filesTouched, ['/repo/src/parser.ts']);
    // The seeded transcript contains one deliberately-broken line.
    assert.ok(
      digest.warnings.some((w) => w.includes('malformed')),
      JSON.stringify(digest.warnings),
    );
  });

  it('excludes interleaved sidechain records (both user and assistant) from the digest', async () => {
    const home = await tempHome();
    // A main-session transcript (first record is not sidechain, so the file
    // is not dropped) with a sub-agent's sidechain user AND assistant records
    // interleaved. None of the sidechain content may enter the main handoff.
    const dir = join(home, '.claude', 'projects', '-repo');
    await mkdir(dir, { recursive: true });
    const id = '0fb0463a-ec8e-4d50-896d-c825c3148ae7';
    await writeFile(
      join(dir, `${id}.jsonl`),
      [
        claudeLine({
          type: 'user',
          cwd: '/repo',
          isSidechain: false,
          message: { content: 'main request' },
        }),
        claudeLine({
          type: 'user',
          isSidechain: true,
          message: { content: 'SIDECHAIN USER PROMPT' },
        }),
        claudeLine({
          type: 'assistant',
          isSidechain: true,
          message: {
            content: [
              { type: 'text', text: 'SIDECHAIN ASSISTANT REPLY' },
              { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/sidechain-only.ts' } },
            ],
          },
        }),
        claudeLine({
          type: 'assistant',
          isSidechain: false,
          message: {
            content: [
              { type: 'text', text: 'main reply' },
              { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/main.ts' } },
            ],
          },
        }),
      ].join(''),
      'utf8',
    );
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const [session] = await store.listSessions();
    assert.ok(session);
    const digest = await store.readDigest(session);
    assert.deepEqual(digest.userMessages, ['main request']);
    assert.deepEqual(digest.assistantTexts, ['main reply']);
    assert.deepEqual(digest.filesTouched, ['/repo/main.ts']);
    const flat = JSON.stringify(digest);
    assert.ok(!flat.includes('SIDECHAIN'), flat);
    assert.ok(!flat.includes('sidechain-only.ts'), flat);
  });

  it('reads codex rollout digests and drops function calls', async () => {
    const home = await tempHome();
    await seedCodexSqlite(home, [{ id: 'c1', cwd: '/repo' }]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const [session] = await store.listSessions();
    assert.ok(session);
    const digest = await store.readDigest(session);
    assert.deepEqual(digest.userMessages, ['codex task']);
    assert.deepEqual(digest.assistantTexts, ['codex reply']);
    const flat = JSON.stringify(digest);
    assert.ok(!flat.includes('rm -rf'), flat);
  });

  it('reads OpenCode digests without tool output, thinking, or child sessions', async () => {
    const home = await tempHome();
    await seedOpenCodeDb(home, [
      {
        id: 'ses_main',
        cwd: '/repo',
        title: 'parser',
        userText: '帮我修复解析器 AIzaSyA1234567890abcdefghijklmnop',
        assistantText: '已修复并补了测试',
        filePath: '/repo/src/parser.ts',
        toolOutput: 'TOOL_OUTPUT rm -rf / leaked-secret',
        thinking: 'SECRET_THINKING do not hand off',
      },
      {
        id: 'ses_child',
        cwd: '/repo',
        parentId: 'ses_main',
        userText: 'CHILD_USER',
        assistantText: 'CHILD_ASSISTANT',
      },
    ]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const listed = await store.listSessions();
    assert.deepEqual(
      listed.map((s) => s.id),
      ['ses_main'],
    );
    const digest = await store.readDigest(listed[0]!);
    assert.equal(digest.source, 'opencode');
    assert.deepEqual(digest.assistantTexts, ['已修复并补了测试']);
    assert.deepEqual(digest.filesTouched, ['/repo/src/parser.ts']);
    assert.equal(digest.userMessages.length, 1);
    assert.match(digest.userMessages[0]!, /帮我修复解析器/);
    assert.ok(
      !digest.userMessages[0]!.includes('AIzaSyA1234567890abcdefghijklmnop'),
      digest.userMessages[0],
    );
    const flat = JSON.stringify(digest);
    assert.ok(!flat.includes('TOOL_OUTPUT'), flat);
    assert.ok(!flat.includes('rm -rf'), flat);
    assert.ok(!flat.includes('SECRET_THINKING'), flat);
    assert.ok(!flat.includes('CHILD_USER'), flat);
    await assert.rejects(
      () =>
        store.readDigest({
          source: 'opencode',
          id: 'ses_child',
          title: 'subagent',
          cwd: '/repo',
          updatedAtMs: NOW,
          transcriptPath: listed[0]!.transcriptPath,
        }),
      /child/,
    );
  });

  it('stops OpenCode digest iteration at the byte cap and keeps the newest text', async () => {
    const home = await tempHome();
    const dbPath = await seedOpenCodeDb(home, [
      {
        id: 'ses_big',
        cwd: '/repo',
        userText: 'OLD_USER_SHOULD_DROP',
        assistantText: 'NEW_ASSISTANT_KEEP',
      },
    ]);
    const db = new DatabaseSync(dbPath);
    try {
      const assistant = db
        .prepare(`SELECT id FROM message WHERE session_id = ? AND data LIKE '%assistant%'`)
        .get('ses_big') as { id: string };
      db.prepare(
        `UPDATE part SET time_created = time_created + 10000 WHERE message_id = ? AND data LIKE '%NEW_ASSISTANT_KEEP%'`,
      ).run(assistant.id);
      const insert = db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
      );
      const chunk = 'y'.repeat(Math.floor(FOREIGN_SESSION_DIGEST_MAX_READ_BYTES / 2) + 1024);
      for (let i = 0; i < 3; i++) {
        insert.run(
          `part_fill_${i}`,
          assistant.id,
          'ses_big',
          NOW - 55_000 + i,
          JSON.stringify({ type: 'tool', tool: 'read', state: { output: chunk } }),
        );
      }
    } finally {
      db.close();
    }
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const [session] = await store.listSessions();
    assert.ok(session);
    const digest = await store.readDigest(session);
    assert.ok(
      digest.warnings.some((w) => w.includes(`${FOREIGN_SESSION_DIGEST_MAX_READ_BYTES}`)),
      JSON.stringify(digest.warnings),
    );
    assert.ok(
      digest.assistantTexts.some((t) => t.includes('NEW_ASSISTANT_KEEP')),
      JSON.stringify(digest.assistantTexts),
    );
    const flat = JSON.stringify(digest);
    assert.ok(!flat.includes('OLD_USER_SHOULD_DROP'), flat);
  });

  it('refuses a transcript path replaced by an out-of-root symlink', async () => {
    const home = await tempHome();
    const path = await seedClaudeSession(home, { id: 'sym', cwd: '/repo' });
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const [session] = await store.listSessions();
    assert.ok(session);
    // Swap the transcript for a symlink pointing outside ~/.claude.
    const secret = join(home, 'secret.txt');
    await writeFile(secret, 'not yours', 'utf8');
    const { rm } = await import('node:fs/promises');
    await rm(path);
    await symlink(secret, path);
    await assert.rejects(() => store.readDigest(session as ForeignSessionSummary), /escaped/);
  });

  it('refuses an OpenCode database replaced by an out-of-root symlink', async () => {
    const home = await tempHome();
    const dbPath = await seedOpenCodeDb(home, [{ id: 'ses_sym', cwd: '/repo' }]);
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const [session] = await store.listSessions();
    assert.ok(session);
    const secret = join(home, 'secret.db');
    await writeFile(secret, 'not yours', 'utf8');
    const { rm } = await import('node:fs/promises');
    await rm(dbPath);
    await symlink(secret, dbPath);
    await assert.rejects(() => store.readDigest(session as ForeignSessionSummary), /escaped/);
  });
});
