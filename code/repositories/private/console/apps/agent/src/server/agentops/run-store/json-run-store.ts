/**
 * JSON-based Run Store implementation
 * 使用文件系统存储 Run 记录，支持审计和历史查询
 *
 * 目录结构:
 * runs/
 *   index.json          - Run 索引列表（最新在前）
 *   <runId>/
 *     run.json          - 完整 Run 记录
 *     backups/          - 原始配置备份目录
 *     artifacts/        - 执行产物目录
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

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

/**
 * Run 索引文件结构
 */
interface RunIndex {
  runs: RunIndexItem[]
}

/**
 * JsonRunStore 配置
 */
export interface JsonRunStoreConfig {
  /** runs 目录路径 */
  runsDir: string
}

// ============================================================================
// JsonRunStore Implementation
// ============================================================================

export class JsonRunStore {
  private readonly runsDir: string
  private readonly indexPath: string

  constructor(config: JsonRunStoreConfig) {
    this.runsDir = config.runsDir
    this.indexPath = path.join(this.runsDir, 'index.json')
  }

  /**
   * 确保 runs 目录存在
   */
  async ensureRunDir(runId: string): Promise<string> {
    const runDir = path.join(this.runsDir, runId)
    await fs.mkdir(runDir, { recursive: true })
    // 预创建 backups 和 artifacts 目录（为 apply 模式预留）
    await fs.mkdir(path.join(runDir, 'backups'), { recursive: true })
    await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
    return runDir
  }

  /**
   * 创建新的 Run 记录
   */
  async createRun(mode: RunMode, plan: Plan): Promise<RunRecord> {
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

    // 确保目录存在
    await this.ensureRunDir(runId)

    // 写入 run.json
    await this.writeRun(run)

    // 更新索引
    await this.addToIndex(run)

    return run
  }

  /**
   * 追加时间线事件
   */
  async appendTimeline(
    runId: string,
    eventType: TimelineEventType,
    message: string,
    details?: Record<string, unknown>
  ): Promise<TimelineEvent> {
    const run = await this.readRun(runId)
    if (!run) {
      throw new Error(`Run not found: ${runId}`)
    }

    const event: TimelineEvent = {
      type: eventType,
      timestamp: new Date().toISOString(),
      message,
      details,
    }

    run.timeline.push(event)
    await this.writeRun(run)

    return event
  }

  /**
   * 完成 Run（成功或失败）
   */
  async finalizeRun(
    runId: string,
    result: RunResult,
    error?: string
  ): Promise<RunRecord> {
    const run = await this.readRun(runId)
    if (!run) {
      throw new Error(`Run not found: ${runId}`)
    }

    run.result = result
    run.completedAt = new Date().toISOString()
    if (error) {
      run.error = error
    }

    await this.writeRun(run)
    await this.updateIndexResult(runId, result, run.completedAt)

    return run
  }

  /**
   * 读取单个 Run 记录
   */
  async readRun(runId: string): Promise<RunRecord | null> {
    const runPath = path.join(this.runsDir, runId, 'run.json')
    try {
      const content = await fs.readFile(runPath, 'utf-8')
      return JSON.parse(content) as RunRecord
    } catch {
      return null
    }
  }

  /**
   * 列出所有 Run（最新在前）
   */
  async listRuns(): Promise<RunIndexItem[]> {
    const index = await this.readIndex()
    return index.runs
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

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async writeRun(run: RunRecord): Promise<void> {
    const runPath = path.join(this.runsDir, run.id, 'run.json')
    await fs.writeFile(runPath, JSON.stringify(run, null, 2), 'utf-8')
  }

  private async readIndex(): Promise<RunIndex> {
    try {
      const content = await fs.readFile(this.indexPath, 'utf-8')
      return JSON.parse(content) as RunIndex
    } catch {
      return { runs: [] }
    }
  }

  private async writeIndex(index: RunIndex): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true })
    await fs.writeFile(this.indexPath, JSON.stringify(index, null, 2), 'utf-8')
  }

  private async addToIndex(run: RunRecord): Promise<void> {
    const index = await this.readIndex()

    const indexItem: RunIndexItem = {
      id: run.id,
      mode: run.mode,
      result: run.result,
      targets: run.plan.targets,
      createdAt: run.createdAt,
    }

    // 插入到最前面（最新在前）
    index.runs.unshift(indexItem)

    await this.writeIndex(index)
  }

  private async updateIndexResult(
    runId: string,
    result: RunResult,
    completedAt: string
  ): Promise<void> {
    const index = await this.readIndex()

    const item = index.runs.find((r) => r.id === runId)
    if (item) {
      item.result = result
      item.completedAt = completedAt
    }

    await this.writeIndex(index)
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * 创建 JsonRunStore 实例
 */
export function createJsonRunStore(runsDir: string): JsonRunStore {
  return new JsonRunStore({ runsDir })
}
