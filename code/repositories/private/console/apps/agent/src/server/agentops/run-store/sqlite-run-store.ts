/**
 * SQLite-based Run Store implementation
 * 使用 Node 24 内置 node:sqlite 存储 Run 记录（原 sql.js WASM 实现的等价替换）
 *
 * 相比 JSON 版本：
 * - 更好的并发安全
 * - 更高效的查询
 * - 支持更大的数据量
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import type {
  RunRecord,
  RunMode,
  RunResult,
  TimelineEvent,
  TimelineEventType,
  Plan,
  RunIndexItem,
} from '@ggbdpq/console-shared'

// ============================================================================
// Types
// ============================================================================

export interface SqliteRunStoreConfig {
  /** runs 目录路径 */
  runsDir: string
  /** 数据库文件名 */
  dbFileName?: string
}

interface RunRow {
  id: string
  mode: string
  result: string
  plan: string
  timeline: string
  error: string | null
  created_at: string
  completed_at: string | null
}

// ============================================================================
// SqliteRunStore Implementation
// ============================================================================

export class SqliteRunStore {
  private readonly runsDir: string
  private readonly dbPath: string
  private db: DatabaseSync | null = null

  constructor(config: SqliteRunStoreConfig) {
    this.runsDir = config.runsDir
    this.dbPath = path.join(config.runsDir, config.dbFileName ?? 'runs.db')
  }

  /**
   * 初始化数据库
   */
  async init(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true })

    this.db = new DatabaseSync(this.dbPath)

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        result TEXT NOT NULL,
        plan TEXT NOT NULL,
        timeline TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
      )
    `)
  }

  /**
   * 确保 Run 目录存在
   */
  async ensureRunDir(runId: string): Promise<string> {
    const runDir = path.join(this.runsDir, runId)
    await fs.mkdir(runDir, { recursive: true })
    await fs.mkdir(path.join(runDir, 'backups'), { recursive: true })
    await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
    return runDir
  }

  /**
   * 创建新的 Run 记录
   */
  async createRun(mode: RunMode, plan: Plan): Promise<RunRecord> {
    this.ensureDb()

    const now = new Date().toISOString()
    const runId = randomUUID()

    const run: RunRecord = {
      id: runId,
      mode,
      result: 'pending',
      plan,
      timeline: [],
      createdAt: now,
    }

    this.db!
      .prepare(
        `INSERT INTO runs (id, mode, result, plan, timeline, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, mode, 'pending', JSON.stringify(plan), '[]', now)

    await this.ensureRunDir(runId)

    return run
  }

  /**
   * 追加时间线事件
   */
  async appendTimeline(
    runId: string,
    eventType: TimelineEventType,
    message: string,
    details?: Record<string, unknown>,
  ): Promise<TimelineEvent> {
    this.ensureDb()

    const event: TimelineEvent = {
      type: eventType,
      timestamp: new Date().toISOString(),
      message,
      details,
    }

    const row = this.db!.prepare('SELECT timeline FROM runs WHERE id = ?').get(runId) as
      | { timeline: string }
      | undefined
    if (!row) {
      throw new Error(`Run not found: ${runId}`)
    }

    const timeline = JSON.parse(row.timeline) as TimelineEvent[]
    timeline.push(event)

    this.db!.prepare('UPDATE runs SET timeline = ? WHERE id = ?').run(JSON.stringify(timeline), runId)

    return event
  }

  /**
   * 完成 Run（成功或失败）
   */
  async finalizeRun(runId: string, result: RunResult, error?: string): Promise<RunRecord> {
    this.ensureDb()

    const completedAt = new Date().toISOString()

    this.db!
      .prepare(`UPDATE runs SET result = ?, error = ?, completed_at = ? WHERE id = ?`)
      .run(result, error ?? null, completedAt, runId)

    const run = await this.readRun(runId)
    if (!run) {
      throw new Error(`Run not found: ${runId}`)
    }

    return run
  }

  /**
   * 读取单个 Run 记录
   */
  async readRun(runId: string): Promise<RunRecord | null> {
    this.ensureDb()

    const row = this.db!
      .prepare(
        `SELECT id, mode, result, plan, timeline, error, created_at, completed_at
         FROM runs WHERE id = ?`,
      )
      .get(runId) as RunRow | undefined

    if (!row) {
      return null
    }

    return this.rowToRunRecord(row)
  }

  /**
   * 列出所有 Run（最新在前）
   */
  async listRuns(): Promise<RunIndexItem[]> {
    this.ensureDb()

    const rows = this.db!
      .prepare(
        `SELECT id, mode, result, plan, created_at, completed_at
         FROM runs ORDER BY created_at DESC`,
      )
      .all() as Array<Pick<RunRow, 'id' | 'mode' | 'result' | 'plan' | 'created_at' | 'completed_at'>>

    return rows.map((row) => {
      const plan = JSON.parse(row.plan) as Plan
      return {
        id: row.id,
        mode: row.mode as RunMode,
        result: row.result as RunResult,
        targets: plan.targets,
        createdAt: row.created_at,
        completedAt: row.completed_at || undefined,
      }
    })
  }

  /**
   * 获取 Run 目录路径
   */
  getRunDir(runId: string): string {
    return path.join(this.runsDir, runId)
  }

  /**
   * 获取备份目录路径
   */
  getBackupsDir(runId: string): string {
    return path.join(this.runsDir, runId, 'backups')
  }

  /**
   * 获取产物目录路径
   */
  getArtifactsDir(runId: string): string {
    return path.join(this.runsDir, runId, 'artifacts')
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private ensureDb(): void {
    if (!this.db) {
      throw new Error('Database not initialized. Call init() first.')
    }
  }

  private rowToRunRecord(row: RunRow): RunRecord {
    return {
      id: row.id,
      mode: row.mode as RunMode,
      result: row.result as RunResult,
      plan: JSON.parse(row.plan) as Plan,
      timeline: JSON.parse(row.timeline) as TimelineEvent[],
      error: row.error || undefined,
      createdAt: row.created_at,
      completedAt: row.completed_at || undefined,
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * 创建并初始化 SqliteRunStore 实例
 */
export async function createSqliteRunStore(runsDir: string): Promise<SqliteRunStore> {
  const store = new SqliteRunStore({ runsDir })
  await store.init()
  return store
}
