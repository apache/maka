/**
 * Progress Parser Service 测试
 * 使用 fixtures 覆盖各种边界情况
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseProgressContent,
  getValidProgressEntries,
  toProgressEntry,
} from '@/server/governance/services/progress-parser'

const FIXTURES_DIR = join(__dirname, 'fixtures/progress')

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8')
}

describe('parseProgressContent', () => {
  describe('成功解析', () => {
    it('解析 multiple-entries.txt 包含多条记录', () => {
      const content = readFixture('multiple-entries.txt')
      const result = parseProgressContent(content)

      expect(result.entries.length).toBeGreaterThan(1)
      // 检查第一条记录
      const firstEntry = result.entries[0]
      expect(firstEntry).toBeDefined()
      expect(firstEntry!.datetime).not.toBeNull()
      expect(firstEntry!.prdId).toBe('PRD-01')
      expect(firstEntry!.component).toBe('ProjectScaffold')
      expect(firstEntry!.priority).toBe('P0')
    })

    it('解析 single-entry.txt 包含单条记录', () => {
      const content = readFixture('single-entry.txt')
      const result = parseProgressContent(content)

      expect(result.entries).toHaveLength(1)
      const entry = result.entries[0]
      expect(entry).toBeDefined()
      expect(entry!.prdId).toBe('PRD-00')
      expect(entry!.component).toBe('BlockingDecision')
    })

    it('提取 What 字段', () => {
      const content = readFixture('multiple-entries.txt')
      const result = parseProgressContent(content)

      const entry = result.entries[0]
      expect(entry!.what).toContain('项目骨架')
    })

    it('提取 Why 字段', () => {
      const content = readFixture('multiple-entries.txt')
      const result = parseProgressContent(content)

      const entry = result.entries[0]
      expect(entry!.why).toContain('基础')
    })

    it('提取 typecheck 结果', () => {
      const content = readFixture('multiple-entries.txt')
      const result = parseProgressContent(content)

      const entry = result.entries[0]
      expect(entry!.typecheckResult).toContain('通过')
    })

    it('提取 commit message', () => {
      const content = readFixture('multiple-entries.txt')
      const result = parseProgressContent(content)

      const entry = result.entries[0]
      expect(entry!.commitMessage).toContain('scaffold')
    })

    it('提取 next', () => {
      const content = readFixture('single-entry.txt')
      const result = parseProgressContent(content)

      const entry = result.entries[0]
      expect(entry!.next).toContain('PRD-01')
    })
  })

  describe('边界情况', () => {
    it('empty.txt 返回空列表', () => {
      const content = readFixture('empty.txt')
      const result = parseProgressContent(content)

      expect(result.entries).toHaveLength(0)
      expect(result.warnings).toHaveLength(0)
    })

    it('missing-fields.txt 生成警告', () => {
      const content = readFixture('missing-fields.txt')
      const result = parseProgressContent(content)

      expect(result.entries.length).toBeGreaterThan(0)
      // 缺少 priority 等字段
      const entry = result.entries[0]
      expect(entry!.priority).toBeNull()
    })

    it('malformed.txt 返回空列表并有警告', () => {
      const content = readFixture('malformed.txt')
      const result = parseProgressContent(content)

      expect(result.entries).toHaveLength(0)
      expect(result.warnings.length).toBeGreaterThan(0)
    })
  })

  describe('日期解析', () => {
    it('正确解析 YYYY-MM-DD 格式', () => {
      const content = readFixture('single-entry.txt')
      const result = parseProgressContent(content)

      const entry = result.entries[0]
      expect(entry!.datetime).not.toBeNull()
      expect(entry!.datetime!.getFullYear()).toBe(2026)
      expect(entry!.datetime!.getMonth()).toBe(0) // January
      expect(entry!.datetime!.getDate()).toBe(10)
    })
  })
})

describe('toProgressEntry', () => {
  it('完整字段返回 ProgressEntry', () => {
    const parsed = {
      datetime: new Date('2026-01-12'),
      prdId: 'PRD-00',
      component: 'Test',
      priority: 'P0' as const,
      what: 'did something',
      why: 'because',
      typecheckResult: 'passed',
      commitMessage: 'feat: test',
      next: 'PRD-01',
      rawContent: 'raw',
    }

    const entry = toProgressEntry(parsed)
    expect(entry).not.toBeNull()
    expect(entry!.prdId).toBe('PRD-00')
  })

  it('缺少 datetime 返回 null', () => {
    const parsed = {
      datetime: null,
      prdId: 'PRD-00',
      component: 'Test',
      priority: 'P0' as const,
      what: '',
      why: '',
      typecheckResult: '',
      commitMessage: '',
      next: '',
      rawContent: '',
    }

    const entry = toProgressEntry(parsed)
    expect(entry).toBeNull()
  })

  it('缺少 prdId 返回 null', () => {
    const parsed = {
      datetime: new Date(),
      prdId: null,
      component: 'Test',
      priority: 'P0' as const,
      what: '',
      why: '',
      typecheckResult: '',
      commitMessage: '',
      next: '',
      rawContent: '',
    }

    const entry = toProgressEntry(parsed)
    expect(entry).toBeNull()
  })
})

describe('getValidProgressEntries', () => {
  it('过滤掉不完整的条目', () => {
    const content = readFixture('missing-fields.txt')
    const result = parseProgressContent(content)
    const validEntries = getValidProgressEntries(result)

    // missing-fields.txt 缺少 priority，应该被过滤
    expect(validEntries.length).toBe(0)
  })

  it('返回完整的条目', () => {
    const content = readFixture('multiple-entries.txt')
    const result = parseProgressContent(content)
    const validEntries = getValidProgressEntries(result)

    // 所有条目都应该是完整的
    expect(validEntries.length).toBe(result.entries.length)
    for (const entry of validEntries) {
      expect(entry.datetime).toBeInstanceOf(Date)
      expect(entry.prdId).toBeTruthy()
      expect(entry.component).toBeTruthy()
      expect(entry.priority).toMatch(/P[012]/)
    }
  })
})
