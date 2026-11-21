/**
 * practice 域数据层：node:sqlite，git 同步结果落库（data/practice.db，gitignored）。
 * 同步语义为全量替换：git 历史不可变，整表重写最简单且天然幂等。
 * 数据目录显式传参（测试传临时目录）；SQL 一律 prepare().run() 单语句执行。
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import type { PracticeCommit, PracticeRepoSummary, PracticeWindow } from '@ggbdpq/console-shared'

const g = globalThis as typeof globalThis & {
  __practiceDb?: DatabaseSync
  __practiceDbDir?: string
}

/** 缺省数据目录：apps/console/data（与 workflow/todo 等域同址，gitignored） */
export function defaultPracticeDataDir(): string {
  return 'data'
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS commits (
  sha          TEXT PRIMARY KEY,
  repo         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  raw_subject  TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('pr','issue','other')),
  author_name  TEXT NOT NULL,
  author_email TEXT NOT NULL,
  authored_at  TEXT NOT NULL,
  insertions   INTEGER NOT NULL DEFAULT 0,
  deletions    INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER NOT NULL DEFAULT 0,
  tapd_bug     TEXT
)`,
  'CREATE INDEX IF NOT EXISTS idx_commits_authored ON commits(authored_at)',
  'CREATE INDEX IF NOT EXISTS idx_commits_type ON commits(type)',
  'CREATE INDEX IF NOT EXISTS idx_commits_repo ON commits(repo)',
  `CREATE TABLE IF NOT EXISTS commit_files (
  sha        TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  insertions INTEGER NOT NULL DEFAULT 0,
  deletions  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sha, path)
)`,
  `CREATE TABLE IF NOT EXISTS commit_branches (
  sha    TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
  repo   TEXT NOT NULL,
  branch TEXT NOT NULL,
  PRIMARY KEY (sha, branch)
)`,
  'CREATE INDEX IF NOT EXISTS idx_cb_branch ON commit_branches(branch)',
  `CREATE TABLE IF NOT EXISTS repo_sync (
  name      TEXT PRIMARY KEY,
  path      TEXT NOT NULL,
  commits   INTEGER NOT NULL DEFAULT 0,
  error     TEXT,
  synced_at TEXT
)`,
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
]

/** 单语句执行辅助：prepare().run()，规避多语句拼接 */
function run(db: DatabaseSync, sql: string): void {
  db.prepare(sql).run()
}

export function getPracticeDb(dataDir: string = defaultPracticeDataDir()): DatabaseSync {
  const resolved = path.resolve(dataDir)
  // 目录变化（测试隔离）时重开连接；单例仅在同目录内复用
  if (g.__practiceDb && g.__practiceDbDir === resolved) return g.__practiceDb
  if (g.__practiceDb) {
    try {
      g.__practiceDb.close()
    } catch {
      // 已关闭
    }
    g.__practiceDb = undefined
  }
  fs.mkdirSync(resolved, { recursive: true })
  const db = new DatabaseSync(path.join(resolved, 'practice.db'))
  run(db, 'PRAGMA journal_mode = WAL')
  run(db, 'PRAGMA foreign_keys = ON')
  for (const stmt of SCHEMA_STATEMENTS) run(db, stmt)
  g.__practiceDb = db
  g.__practiceDbDir = resolved
  return db
}

export interface SyncedPayload {
  window: PracticeWindow
  authors: string[]
  repos: PracticeRepoSummary[]
  commits: PracticeCommit[]
}

/** 全量替换写入一次同步结果（单事务） */
export function saveSyncedPayload(db: DatabaseSync, payload: SyncedPayload, syncedAt: string): void {
  run(db, 'BEGIN')
  try {
    run(db, 'DELETE FROM commit_files')
    run(db, 'DELETE FROM commit_branches')
    run(db, 'DELETE FROM commits')
    run(db, 'DELETE FROM repo_sync')

    const insCommit = db.prepare(`
      INSERT INTO commits (sha, repo, subject, raw_subject, type, author_name, author_email,
                           authored_at, insertions, deletions, files_changed, tapd_bug)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insFile = db.prepare(
      'INSERT INTO commit_files (sha, path, insertions, deletions) VALUES (?, ?, ?, ?)',
    )
    const insBranch = db.prepare(
      'INSERT INTO commit_branches (sha, repo, branch) VALUES (?, ?, ?)',
    )
    for (const c of payload.commits) {
      insCommit.run(
        c.sha,
        c.repo,
        c.subject,
        c.rawSubject,
        c.type,
        c.authorName,
        c.authorEmail,
        c.authoredAt,
        c.insertions,
        c.deletions,
        c.filesChanged,
        c.tapdBug,
      )
      for (const f of c.files) insFile.run(c.sha, f.path, f.insertions, f.deletions)
      for (const b of c.branches) insBranch.run(c.sha, c.repo, b)
    }

    const insRepo = db.prepare(
      'INSERT INTO repo_sync (name, path, commits, error, synced_at) VALUES (?, ?, ?, ?, ?)',
    )
    for (const r of payload.repos) {
      insRepo.run(r.name, r.path, r.commits, r.error, syncedAt)
    }

    const setMeta = db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    setMeta.run('window_since', payload.window.since)
    setMeta.run('window_until', payload.window.until)
    setMeta.run('authors', JSON.stringify(payload.authors))
    setMeta.run('synced_at', syncedAt)

    run(db, 'COMMIT')
  } catch (err) {
    run(db, 'ROLLBACK')
    throw err
  }
}

interface CommitRow {
  sha: string
  repo: string
  subject: string
  raw_subject: string
  type: string
  author_name: string
  author_email: string
  authored_at: string
  insertions: number
  deletions: number
  files_changed: number
  tapd_bug: string | null
}

/** 读取全部提交（含文件与分支关联），按作者时间倒序 */
export function loadCommits(db: DatabaseSync): PracticeCommit[] {
  const rows = db
    .prepare('SELECT * FROM commits ORDER BY authored_at DESC')
    .all() as unknown as CommitRow[]
  if (rows.length === 0) return []

  const fileRows = db
    .prepare('SELECT sha, path, insertions, deletions FROM commit_files')
    .all() as unknown as Array<{
    sha: string
    path: string
    insertions: number
    deletions: number
  }>
  const branchRows = db
    .prepare('SELECT sha, branch FROM commit_branches')
    .all() as unknown as Array<{
    sha: string
    branch: string
  }>

  const filesBy = new Map<string, PracticeCommit['files']>()
  for (const f of fileRows) {
    const list = filesBy.get(f.sha) ?? []
    list.push({ path: f.path, insertions: f.insertions, deletions: f.deletions })
    filesBy.set(f.sha, list)
  }
  const branchesBy = new Map<string, string[]>()
  for (const b of branchRows) {
    const list = branchesBy.get(b.sha) ?? []
    list.push(b.branch)
    branchesBy.set(b.sha, list)
  }

  return rows.map((r) => ({
    sha: r.sha,
    shortSha: r.sha.slice(0, 8),
    repo: r.repo,
    branches: branchesBy.get(r.sha) ?? [],
    subject: r.subject,
    rawSubject: r.raw_subject,
    type: r.type as PracticeCommit['type'],
    authorName: r.author_name,
    authorEmail: r.author_email,
    authoredAt: r.authored_at,
    insertions: r.insertions,
    deletions: r.deletions,
    filesChanged: r.files_changed,
    tapdBug: r.tapd_bug,
    files: filesBy.get(r.sha) ?? [],
  }))
}

export function loadMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function loadRepoSummaries(db: DatabaseSync): PracticeRepoSummary[] {
  return (
    db
      .prepare('SELECT name, path, commits, error FROM repo_sync ORDER BY name')
      .all() as unknown as Array<{
      name: string
      path: string
      commits: number
      error: string | null
    }>
  ).map((r) => ({ name: r.name, path: r.path, commits: r.commits, error: r.error }))
}
