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
  FOREIGN_SESSION_SCAN_MAX_SESSIONS,
  type ForeignSessionSummary,
} from '@maka/core/foreign-session';
import {
  codexCwdSqlVariants,
  createForeignSessionStore,
  isClaudeCodeImportEnabled,
  isCodexImportEnabled,
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
  source?: string;
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
      t.source ?? 'cli',
    );
  }
  db.close();
}

describe('foreign session store — enable flags', () => {
  it('defaults on, disabled by exactly "0"', () => {
    assert.equal(isClaudeCodeImportEnabled({}), true);
    assert.equal(isClaudeCodeImportEnabled({ MAKA_IMPORT_CLAUDE_CODE: '0' }), false);
    assert.equal(isCodexImportEnabled({ MAKA_IMPORT_CODEX: '1' }), true);
    assert.equal(isCodexImportEnabled({ MAKA_IMPORT_CODEX: '0' }), false);
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
      aiTitle: 'safe‮titlewith sk-ant-api03-abcdefghijklmnop injected',
    });
    const store = createForeignSessionStore({ homeDir: home, env: {} });
    const [session] = await store.listSessions();
    assert.ok(session);
    assert.ok(!session.title.includes('‮'));
    assert.ok(!session.title.includes(''));
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
});
