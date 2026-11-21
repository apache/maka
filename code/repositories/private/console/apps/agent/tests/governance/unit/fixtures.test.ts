/**
 * Fixtures 测试
 * 验证测试 fixtures 文件可被正确读取
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

const FIXTURES_DIR = join(__dirname, 'fixtures')

describe('PRD Fixtures', () => {
  const prdFixturesDir = join(FIXTURES_DIR, 'prd')

  it('all-pending.json 可被读取和解析', () => {
    const content = readFileSync(join(prdFixturesDir, 'all-pending.json'), 'utf-8')
    const data = JSON.parse(content)

    expect(data.items).toHaveLength(3)
    expect(data.items.every((item: { passes: boolean }) => !item.passes)).toBe(true)
    expect(data.statistics.passing).toBe(0)
    expect(data.statistics.completion).toBe('0%')
  })

  it('partial-complete.json 可被读取和解析', () => {
    const content = readFileSync(join(prdFixturesDir, 'partial-complete.json'), 'utf-8')
    const data = JSON.parse(content)

    expect(data.items).toHaveLength(4)
    expect(data.statistics.passing).toBe(2)
    expect(data.statistics.failing).toBe(2)
    expect(data.statistics.completion).toBe('50%')
  })

  it('all-complete.json 可被读取和解析', () => {
    const content = readFileSync(join(prdFixturesDir, 'all-complete.json'), 'utf-8')
    const data = JSON.parse(content)

    expect(data.items).toHaveLength(2)
    expect(data.items.every((item: { passes: boolean }) => item.passes)).toBe(true)
    expect(data.statistics.completion).toBe('100%')
  })

  it('blocked.json 包含 blocked_reason', () => {
    const content = readFileSync(join(prdFixturesDir, 'blocked.json'), 'utf-8')
    const data = JSON.parse(content)

    expect(data.statistics.blocked_reason).not.toBe('')
    expect(data.statistics.blocked_reason).toContain('Blocked on')
  })

  it('inconsistent-stats.json 统计与实际不一致', () => {
    const content = readFileSync(join(prdFixturesDir, 'inconsistent-stats.json'), 'utf-8')
    const data = JSON.parse(content)

    // 实际 passing 数量
    const actualPassing = data.items.filter((item: { passes: boolean }) => item.passes).length
    // statistics 中声明的 passing 数量
    const declaredPassing = data.statistics.passing

    // 验证不一致
    expect(actualPassing).not.toBe(declaredPassing)
    expect(actualPassing).toBe(2) // 实际有 2 个 passes: true
    expect(declaredPassing).toBe(1) // 但 statistics 声明为 1
  })

  it('empty.json 是空列表', () => {
    const content = readFileSync(join(prdFixturesDir, 'empty.json'), 'utf-8')
    const data = JSON.parse(content)

    expect(data.items).toHaveLength(0)
    expect(data.statistics.total).toBe(0)
  })

  it('malformed.json 缺少必要字段', () => {
    const content = readFileSync(join(prdFixturesDir, 'malformed.json'), 'utf-8')
    const data = JSON.parse(content)

    expect(data.items[0].priority).toBeUndefined()
    expect(data.items[0].steps).toBeUndefined()
    expect(data.items[0].passes).toBeUndefined()
    expect(data.statistics).toBeUndefined()
  })

  it('invalid-json.txt 不是有效 JSON', () => {
    const content = readFileSync(join(prdFixturesDir, 'invalid-json.txt'), 'utf-8')

    expect(() => JSON.parse(content)).toThrow()
  })
})

describe('Progress Fixtures', () => {
  const progressFixturesDir = join(FIXTURES_DIR, 'progress')

  it('multiple-entries.txt 包含多条记录', () => {
    const content = readFileSync(join(progressFixturesDir, 'multiple-entries.txt'), 'utf-8')

    // 检查包含多个日期标题
    const dateMatches = content.match(/## \d{4}-\d{2}-\d{2}/g)
    expect(dateMatches).not.toBeNull()
    expect(dateMatches!.length).toBeGreaterThan(1)
  })

  it('single-entry.txt 包含单条记录', () => {
    const content = readFileSync(join(progressFixturesDir, 'single-entry.txt'), 'utf-8')

    const dateMatches = content.match(/## \d{4}-\d{2}-\d{2}/g)
    expect(dateMatches).toHaveLength(1)
  })

  it('missing-fields.txt 缺少一些字段', () => {
    const content = readFileSync(join(progressFixturesDir, 'missing-fields.txt'), 'utf-8')

    // 缺少 What、Why、typecheck 结果等字段
    expect(content).not.toContain('### What')
    expect(content).not.toContain('### Why')
    expect(content).not.toContain('### typecheck')
  })

  it('empty.txt 是空文件', () => {
    const content = readFileSync(join(progressFixturesDir, 'empty.txt'), 'utf-8')

    expect(content).toBe('')
  })

  it('malformed.txt 格式不规范', () => {
    const content = readFileSync(join(progressFixturesDir, 'malformed.txt'), 'utf-8')

    // 不包含标准格式
    expect(content).not.toContain('## 2026')
    expect(content).not.toContain('### 完成内容')
  })
})

describe('Spec Fixtures', () => {
  const specFixturesDir = join(FIXTURES_DIR, 'specs')

  it('complete spec 包含所有三个文件', () => {
    const completeDir = join(specFixturesDir, 'complete')

    expect(existsSync(join(completeDir, 'requirements.md'))).toBe(true)
    expect(existsSync(join(completeDir, 'design.md'))).toBe(true)
    expect(existsSync(join(completeDir, 'tasks.md'))).toBe(true)
  })

  it('missing-requirements spec 缺少 requirements.md', () => {
    const dir = join(specFixturesDir, 'missing-requirements')

    expect(existsSync(join(dir, 'requirements.md'))).toBe(false)
    expect(existsSync(join(dir, 'design.md'))).toBe(true)
    expect(existsSync(join(dir, 'tasks.md'))).toBe(true)
  })

  it('missing-design spec 缺少 design.md', () => {
    const dir = join(specFixturesDir, 'missing-design')

    expect(existsSync(join(dir, 'requirements.md'))).toBe(true)
    expect(existsSync(join(dir, 'design.md'))).toBe(false)
    expect(existsSync(join(dir, 'tasks.md'))).toBe(true)
  })

  it('missing-tasks spec 缺少 tasks.md', () => {
    const dir = join(specFixturesDir, 'missing-tasks')

    expect(existsSync(join(dir, 'requirements.md'))).toBe(true)
    expect(existsSync(join(dir, 'design.md'))).toBe(true)
    expect(existsSync(join(dir, 'tasks.md'))).toBe(false)
  })

  it('empty spec 是空目录', () => {
    const dir = join(specFixturesDir, 'empty')
    const files = readdirSync(dir).filter(f => !f.startsWith('.'))

    expect(files).toHaveLength(0)
  })

  it('所有 spec fixtures 都存在', () => {
    const expectedSpecs = [
      'complete',
      'missing-requirements',
      'missing-design',
      'missing-tasks',
      'empty',
    ]

    for (const spec of expectedSpecs) {
      expect(existsSync(join(specFixturesDir, spec))).toBe(true)
    }
  })
})
