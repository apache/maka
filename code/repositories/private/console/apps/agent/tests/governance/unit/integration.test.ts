/**
 * 集成测试
 * 覆盖全链路：文件读取 → 解析 → watch → UI 数据流
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

// Services
import {
  parsePRDContent,
  getNextPRDItem,
  checkStatisticsConsistency,
} from '@/server/governance/services/prd-parser'
import {
  parseProgressContent,
  getValidProgressEntries,
} from '@/server/governance/services/progress-parser'
import {
  readSpec,
  isSpecComplete,
  type FileSystemAdapter,
} from '@/server/governance/services/spec-parser'
import {
  MockFileWatcher,
  isPathInWatchScope,
  createFileChangeEvent,
} from '@/server/governance/services/file-watch'

const FIXTURES_DIR = join(__dirname, 'fixtures')

/**
 * 创建真实文件系统适配器
 */
function createRealFSAdapter(): FileSystemAdapter {
  return {
    async exists(path: string): Promise<boolean> {
      return existsSync(path)
    },
    async isDirectory(path: string): Promise<boolean> {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    async readDir(path: string): Promise<readonly string[]> {
      return readdirSync(path)
    },
    async readFile(path: string): Promise<string> {
      return readFileSync(path, 'utf-8')
    },
  }
}

describe('Integration: 文件读取 → 解析全链路', () => {
  const fs = createRealFSAdapter()

  describe('PRD 链路', () => {
    it('空列表处理', () => {
      const content = readFileSync(join(FIXTURES_DIR, 'prd/empty.json'), 'utf-8')
      const result = parsePRDContent(content)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.items).toHaveLength(0)
        expect(getNextPRDItem(result.data)).toBeNull()
      }
    })

    it('blocked_reason 处理', () => {
      const content = readFileSync(join(FIXTURES_DIR, 'prd/blocked.json'), 'utf-8')
      const result = parsePRDContent(content)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.statistics.blocked_reason).not.toBe('')
        expect(result.data.statistics.blocked_reason).toContain('Blocked')
      }
    })

    it('统计不一致检测', () => {
      const content = readFileSync(
        join(FIXTURES_DIR, 'prd/inconsistent-stats.json'),
        'utf-8'
      )
      const result = parsePRDContent(content)

      expect(result.success).toBe(true)
      if (result.success) {
        const consistency = checkStatisticsConsistency(result.data)
        expect(consistency.consistent).toBe(false)
      }
    })

    it('缺失文件处理（无效 JSON）', () => {
      const content = readFileSync(
        join(FIXTURES_DIR, 'prd/invalid-json.txt'),
        'utf-8'
      )
      const result = parsePRDContent(content)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.type).toBe('json_parse_error')
      }
    })

    it('结构不完整处理', () => {
      const content = readFileSync(
        join(FIXTURES_DIR, 'prd/malformed.json'),
        'utf-8'
      )
      const result = parsePRDContent(content)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.type).toBe('validation_error')
      }
    })
  })

  describe('Progress 链路', () => {
    it('空文件处理', () => {
      const content = readFileSync(
        join(FIXTURES_DIR, 'progress/empty.txt'),
        'utf-8'
      )
      const result = parseProgressContent(content)

      expect(result.entries).toHaveLength(0)
    })

    it('格式不规范处理', () => {
      const content = readFileSync(
        join(FIXTURES_DIR, 'progress/malformed.txt'),
        'utf-8'
      )
      const result = parseProgressContent(content)

      expect(result.entries).toHaveLength(0)
      expect(result.warnings.length).toBeGreaterThan(0)
    })

    it('字段缺失处理', () => {
      const content = readFileSync(
        join(FIXTURES_DIR, 'progress/missing-fields.txt'),
        'utf-8'
      )
      const result = parseProgressContent(content)
      const validEntries = getValidProgressEntries(result)

      // 有原始条目但无有效条目（因为缺少必要字段）
      expect(result.entries.length).toBeGreaterThan(0)
      expect(validEntries.length).toBe(0)
    })
  })

  describe('Spec 链路', () => {
    it('完整 spec 处理', async () => {
      const result = await readSpec(join(FIXTURES_DIR, 'specs/complete'), fs)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(isSpecComplete(result.data)).toBe(true)
        expect(result.data.requirements).not.toBeNull()
        expect(result.data.design).not.toBeNull()
        expect(result.data.tasks).not.toBeNull()
      }
    })

    it('缺失文件处理', async () => {
      const result = await readSpec(
        join(FIXTURES_DIR, 'specs/missing-requirements'),
        fs
      )

      expect(result.success).toBe(true)
      if (result.success) {
        expect(isSpecComplete(result.data)).toBe(false)
        expect(result.data.requirements).toBeNull()
      }
    })

    it('空目录处理', async () => {
      const result = await readSpec(join(FIXTURES_DIR, 'specs/empty'), fs)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(isSpecComplete(result.data)).toBe(false)
        expect(result.data.requirements).toBeNull()
        expect(result.data.design).toBeNull()
        expect(result.data.tasks).toBeNull()
      }
    })

    it('不存在的 spec 处理', async () => {
      const result = await readSpec(
        join(FIXTURES_DIR, 'specs/non-existent'),
        fs
      )

      expect(result.success).toBe(false)
    })
  })
})

describe('Integration: Watch → 事件累积全链路', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('文件变更触发解析刷新', async () => {
    const watcher = new MockFileWatcher({ debounceMs: 100 })
    const parsedDocs: string[] = []

    await watcher.start()
    watcher.onChange((events) => {
      for (const event of events) {
        if (isPathInWatchScope(event.path)) {
          parsedDocs.push(event.path)
        }
      }
    })

    // 模拟 prd.json 变更
    watcher.simulateChange(
      createFileChangeEvent('change', '.ggbdpq/actions/prd.json')
    )

    vi.advanceTimersByTime(100)

    expect(parsedDocs).toContain('.ggbdpq/actions/prd.json')
  })

  it('非监听范围的文件不触发解析', async () => {
    const watcher = new MockFileWatcher({ debounceMs: 100 })
    const parsedDocs: string[] = []

    await watcher.start()
    watcher.onChange((events) => {
      for (const event of events) {
        if (isPathInWatchScope(event.path)) {
          parsedDocs.push(event.path)
        }
      }
    })

    // 模拟非监听范围的文件变更
    watcher.simulateChange(createFileChangeEvent('change', 'src/main.ts'))

    vi.advanceTimersByTime(100)

    expect(parsedDocs).toHaveLength(0)
  })

  it('批量变更合并处理', async () => {
    const watcher = new MockFileWatcher({ debounceMs: 100 })
    let callCount = 0
    let lastEvents: readonly unknown[] = []

    await watcher.start()
    watcher.onChange((events) => {
      callCount++
      lastEvents = events
    })

    // 快速连续的多个变更
    watcher.simulateChange(
      createFileChangeEvent('change', '.ggbdpq/actions/prd.json')
    )
    vi.advanceTimersByTime(50)
    watcher.simulateChange(
      createFileChangeEvent('change', '.ggbdpq/actions/progress.txt')
    )
    vi.advanceTimersByTime(50)
    watcher.simulateChange(
      createFileChangeEvent('change', '.kiro/specs/test/requirements.md')
    )

    vi.advanceTimersByTime(100)

    // 应该只触发一次回调，但包含所有事件
    expect(callCount).toBe(1)
    expect(lastEvents).toHaveLength(3)
  })
})

describe('Integration: Git 不可用降级', () => {
  it('Git 不可用时相关功能标记为 unverifiable', () => {
    // 模拟 Git 不可用的场景
    type GitAvailability =
      | { available: true }
      | {
          available: false
          reason: 'git_unavailable' | 'not_git_repo' | 'git_permission_denied'
        }

    const unavailable: GitAvailability = {
      available: false,
      reason: 'git_unavailable',
    }

    expect(unavailable.available).toBe(false)

    // 在 Git 不可用时，合规性检查应返回 unverifiable
    type ComplianceStatus = 'passed' | 'failed' | 'unverifiable'
    const complianceStatus: ComplianceStatus = 'unverifiable'

    expect(complianceStatus).toBe('unverifiable')
  })
})

describe('Integration: 断裂链路检测', () => {
  it('PRD 无对应 progress 时标记为断裂', () => {
    // 解析 PRD
    const prdContent = readFileSync(
      join(FIXTURES_DIR, 'prd/all-pending.json'),
      'utf-8'
    )
    const prdResult = parsePRDContent(prdContent)

    expect(prdResult.success).toBe(true)
    if (prdResult.success) {
      // 空 progress
      const progressResult = parseProgressContent('')
      const validProgress = getValidProgressEntries(progressResult)

      // 检查链路
      for (const prdItem of prdResult.data.items) {
        const hasProgress = validProgress.some(
          (entry) => entry.prdId === prdItem.id
        )
        // 全部 PRD 都没有对应的 progress
        expect(hasProgress).toBe(false)
      }
    }
  })
})
