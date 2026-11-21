/**
 * Executor - 执行配置变更
 *
 * 支持三种模式：
 * - dry-run: 只生成计划，不写入文件
 * - apply: 备份 -> 写入 -> 验证
 * - rollback: 从备份恢复
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'

import type {
  Plan,
  PatchStep,
  RunMode,
  RunRecord,
  TargetType,
} from '@ggbdpq/console-shared'

import { JsonRunStore } from '../run-store/index'
import { setByPath, deleteByPath } from '../planner/index'
import { validatePathAllowed } from '../adapters/index'

// ============================================================================
// Types
// ============================================================================

export interface ExecutorConfig {
  /** Run Store 实例 */
  runStore: JsonRunStore
}

export interface ExecuteResult {
  /** Run 记录 */
  run: RunRecord
  /** 是否成功 */
  success: boolean
  /** 错误信息 */
  error?: string
}

// ============================================================================
// Executor Implementation
// ============================================================================

export class Executor {
  private readonly runStore: JsonRunStore

  constructor(config: ExecutorConfig) {
    this.runStore = config.runStore
  }

  /**
   * 执行计划（dry-run 或 apply）
   */
  async execute(plan: Plan, mode: RunMode): Promise<ExecuteResult> {
    // 创建 Run 记录
    const run = await this.runStore.createRun(mode, plan)

    try {
      // 记录扫描完成
      await this.runStore.appendTimeline(run.id, 'scan', 'Configuration scan completed')

      // 记录计划生成
      await this.runStore.appendTimeline(run.id, 'plan', `Generated ${plan.steps.length} steps`, {
        changed: plan.summary.changed,
        deleted: plan.summary.deleted,
        highRisk: plan.summary.highRisk,
      })

      if (mode === 'apply') {
        // 执行 apply
        await this.applyPlan(run.id, plan)
      }

      // 记录完成
      await this.runStore.appendTimeline(run.id, 'done', `Execution completed in ${mode} mode`)

      // 最终化 Run
      const finalRun = await this.runStore.finalizeRun(run.id, 'success')

      return { run: finalRun, success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // 记录错误
      await this.runStore.appendTimeline(run.id, 'error', errorMessage)

      // 最终化 Run
      const finalRun = await this.runStore.finalizeRun(run.id, 'error', errorMessage)

      return { run: finalRun, success: false, error: errorMessage }
    }
  }

  /**
   * 回滚指定的 Run
   */
  async rollback(runId: string): Promise<ExecuteResult> {
    const run = await this.runStore.readRun(runId)
    if (!run) {
      throw new Error(`Run not found: ${runId}`)
    }

    if (run.mode !== 'apply') {
      throw new Error(`Cannot rollback a ${run.mode} run`)
    }

    if (run.result === 'rolled-back') {
      throw new Error(`Run ${runId} has already been rolled back`)
    }

    try {
      // 记录开始回滚
      await this.runStore.appendTimeline(runId, 'rollback', 'Starting rollback')

      // 恢复每个目标的备份
      for (const target of run.plan.targets) {
        await this.restoreBackup(runId, target.type, target.path!)
      }

      // 记录完成
      await this.runStore.appendTimeline(runId, 'done', 'Rollback completed')

      // 最终化 Run
      const finalRun = await this.runStore.finalizeRun(runId, 'rolled-back')

      return { run: finalRun, success: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // 记录错误
      await this.runStore.appendTimeline(runId, 'error', `Rollback failed: ${errorMessage}`)

      return {
        run: (await this.runStore.readRun(runId))!,
        success: false,
        error: errorMessage,
      }
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * 执行 apply 操作
   */
  private async applyPlan(runId: string, plan: Plan): Promise<void> {
    // 按目标分组 steps
    const stepsByTarget = this.groupStepsByTarget(plan.steps)

    for (const [targetKey, steps] of stepsByTarget) {
      const firstStep = steps[0]!
      const targetPath = firstStep.target.path!
      const targetType = firstStep.target.type

      // 验证路径在白名单内
      validatePathAllowed(targetPath)

      // 备份原文件
      await this.backupFile(runId, targetType, targetPath)
      await this.runStore.appendTimeline(runId, 'backup', `Backed up ${targetKey}`)

      // 读取当前配置
      let currentSettings: Record<string, unknown> = {}
      try {
        const content = await fs.readFile(targetPath, 'utf-8')
        currentSettings = JSON.parse(content) as Record<string, unknown>
      } catch {
        // 文件不存在，使用空对象
      }

      // 应用变更
      const nextSettings = this.applySteps(currentSettings, steps)

      // 原子写入
      await this.atomicWrite(targetPath, nextSettings)
      await this.runStore.appendTimeline(runId, 'patch', `Applied ${steps.length} changes to ${targetKey}`)

      // 验证写入结果
      await this.validateWrittenFile(targetPath)
      await this.runStore.appendTimeline(runId, 'validate', `Validated ${targetKey}`)
    }
  }

  /**
   * 备份文件到 runs/<runId>/backups/<target>/settings.json
   */
  private async backupFile(
    runId: string,
    targetType: TargetType,
    originalPath: string
  ): Promise<void> {
    const backupsDir = this.runStore.getBackupsDir(runId)
    const backupDir = path.join(backupsDir, targetType)
    await fs.mkdir(backupDir, { recursive: true })

    const backupPath = path.join(backupDir, 'settings.json')

    try {
      await fs.copyFile(originalPath, backupPath)
    } catch (error) {
      // 如果原文件不存在，创建一个空的备份标记
      if (isNotFoundError(error)) {
        await fs.writeFile(backupPath, '{}', 'utf-8')
      } else {
        throw error
      }
    }
  }

  /**
   * 从备份恢复文件
   */
  private async restoreBackup(
    runId: string,
    targetType: TargetType,
    originalPath: string
  ): Promise<void> {
    const backupsDir = this.runStore.getBackupsDir(runId)
    const backupPath = path.join(backupsDir, targetType, 'settings.json')

    // 验证路径在白名单内
    validatePathAllowed(originalPath)

    // 使用原子写入恢复
    const content = await fs.readFile(backupPath, 'utf-8')
    const settings = JSON.parse(content) as Record<string, unknown>
    await this.atomicWrite(originalPath, settings)
  }

  /**
   * 应用 steps 到当前配置
   */
  private applySteps(
    current: Record<string, unknown>,
    steps: PatchStep[]
  ): Record<string, unknown> {
    // 克隆当前配置
    const result = JSON.parse(JSON.stringify(current)) as Record<string, unknown>

    for (const step of steps) {
      if (step.op === 'set') {
        setByPath(result, step.path, step.value)
      } else if (step.op === 'delete') {
        deleteByPath(result, step.path)
      }
    }

    return result
  }

  /**
   * 原子写入文件（临时文件 -> rename）
   */
  private async atomicWrite(
    targetPath: string,
    content: Record<string, unknown>
  ): Promise<void> {
    const dir = path.dirname(targetPath)
    await fs.mkdir(dir, { recursive: true })

    // 创建临时文件
    const tempPath = path.join(os.tmpdir(), `config-agent-${randomUUID()}.json`)
    const jsonContent = JSON.stringify(content, null, 2)

    await fs.writeFile(tempPath, jsonContent, 'utf-8')

    // 原子 rename
    await fs.rename(tempPath, targetPath)
  }

  /**
   * 验证写入的文件
   */
  private async validateWrittenFile(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(content)

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid settings file: expected object, got ${typeof parsed}`)
    }
  }

  /**
   * 按目标分组 steps
   */
  private groupStepsByTarget(steps: PatchStep[]): Map<string, PatchStep[]> {
    const map = new Map<string, PatchStep[]>()

    for (const step of steps) {
      const key = `${step.target.type}:${step.target.fileType}`
      const existing = map.get(key) ?? []
      existing.push(step)
      map.set(key, existing)
    }

    return map
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * 创建 Executor 实例
 */
export function createExecutor(runStore: JsonRunStore): Executor {
  return new Executor({ runStore })
}

// ============================================================================
// Helpers
// ============================================================================

function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}
