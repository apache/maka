/**
 * PRD Parser Service 测试
 * 使用 fixtures 覆盖各种边界情况
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parsePRDContent,
  validatePRDDocument,
  getNextPRDItem,
  checkStatisticsConsistency,
} from '@/server/governance/services/prd-parser'

const FIXTURES_DIR = join(__dirname, 'fixtures/prd')

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8')
}

describe('parsePRDContent', () => {
  describe('成功解析', () => {
    it('解析 all-pending.json', () => {
      const content = readFixture('all-pending.json')
      const result = parsePRDContent(content)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.items).toHaveLength(3)
        expect(result.data.items.every((item) => !item.passes)).toBe(true)
        expect(result.data.statistics.completion).toBe('0%')
      }
    })

    it('解析 partial-complete.json', () => {
      const content = readFixture('partial-complete.json')
      const result = parsePRDContent(content)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.items).toHaveLength(4)
        expect(result.data.statistics.passing).toBe(2)
        expect(result.data.statistics.failing).toBe(2)
      }
    })

    it('解析 all-complete.json', () => {
      const content = readFixture('all-complete.json')
      const result = parsePRDContent(content)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.items.every((item) => item.passes)).toBe(true)
        expect(result.data.statistics.completion).toBe('100%')
      }
    })

    it('解析 blocked.json', () => {
      const content = readFixture('blocked.json')
      const result = parsePRDContent(content)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.statistics.blocked_reason).toContain('Blocked on')
      }
    })

    it('解析 empty.json（空列表）', () => {
      const content = readFixture('empty.json')
      const result = parsePRDContent(content)

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.items).toHaveLength(0)
        expect(result.data.statistics.total).toBe(0)
      }
    })
  })

  describe('解析失败', () => {
    it('invalid-json.txt 返回 JSON 解析错误', () => {
      const content = readFixture('invalid-json.txt')
      const result = parsePRDContent(content)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.type).toBe('json_parse_error')
        expect(result.error.message).toBe('JSON 解析失败')
      }
    })

    it('malformed.json 返回校验错误', () => {
      const content = readFixture('malformed.json')
      const result = parsePRDContent(content)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.type).toBe('validation_error')
        expect(result.error.message).toBe('结构校验失败')
        expect(result.error.details).toContain('priority')
        expect(result.error.details).toContain('steps')
        expect(result.error.details).toContain('passes')
        expect(result.error.details).toContain('priority')
      }
    })
  })
})

describe('validatePRDDocument', () => {
  it('有效文档返回 valid: true', () => {
    const data = {
      items: [
        { id: 'PRD-00', component: 'Test', priority: 'P0', steps: ['step'], passes: false },
      ],
      statistics: {
        total: 1,
        passing: 0,
        failing: 1,
        completion: '0%',
        blocked_reason: '',
      },
    }

    const result = validatePRDDocument(data)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('非对象返回错误', () => {
    const result = validatePRDDocument('not an object')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('根对象必须是 object')
  })

  it('items 不是数组返回错误', () => {
    const result = validatePRDDocument({ items: 'not array', statistics: {} })
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('items: 必须是数组')
  })

  it('缺少 statistics 时容忍（运行时从 items 推导）', () => {
    // 2026-08-30 契约放宽：真实 .ggbdpq 工件普遍无 statistics 字段
    const result = validatePRDDocument({ items: [] })
    expect(result.valid).toBe(true)
  })

  it('无效的 priority 返回错误', () => {
    const data = {
      items: [
        { id: 'PRD-00', component: 'Test', priority: 'P3', steps: [], passes: false },
      ],
      statistics: {
        total: 1,
        passing: 0,
        failing: 1,
        completion: '0%',
        blocked_reason: '',
      },
    }

    const result = validatePRDDocument(data)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('priority'))).toBe(true)
  })

  it('passes 不是布尔值返回错误', () => {
    const data = {
      items: [
        { id: 'PRD-00', component: 'Test', priority: 'P0', steps: [], passes: 'true' },
      ],
      statistics: {
        total: 1,
        passing: 0,
        failing: 1,
        completion: '0%',
        blocked_reason: '',
      },
    }

    const result = validatePRDDocument(data)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('passes'))).toBe(true)
  })
})

describe('getNextPRDItem', () => {
  it('返回 passes: false 中优先级最高、id 最小的 item', () => {
    const content = readFixture('partial-complete.json')
    const result = parsePRDContent(content)

    expect(result.success).toBe(true)
    if (result.success) {
      const next = getNextPRDItem(result.data)
      expect(next).not.toBeNull()
      expect(next!.id).toBe('PRD-02') // P1, id 最小的未完成 item
    }
  })

  it('全部完成时返回 null', () => {
    const content = readFixture('all-complete.json')
    const result = parsePRDContent(content)

    expect(result.success).toBe(true)
    if (result.success) {
      const next = getNextPRDItem(result.data)
      expect(next).toBeNull()
    }
  })

  it('空列表返回 null', () => {
    const content = readFixture('empty.json')
    const result = parsePRDContent(content)

    expect(result.success).toBe(true)
    if (result.success) {
      const next = getNextPRDItem(result.data)
      expect(next).toBeNull()
    }
  })

  it('P0 优先于 P1', () => {
    const content = readFixture('all-pending.json')
    const result = parsePRDContent(content)

    expect(result.success).toBe(true)
    if (result.success) {
      const next = getNextPRDItem(result.data)
      expect(next).not.toBeNull()
      expect(next!.priority).toBe('P0')
    }
  })
})

describe('checkStatisticsConsistency', () => {
  it('一致的统计返回 consistent: true', () => {
    const content = readFixture('all-pending.json')
    const result = parsePRDContent(content)

    expect(result.success).toBe(true)
    if (result.success) {
      const consistency = checkStatisticsConsistency(result.data)
      expect(consistency.consistent).toBe(true)
      expect(consistency.actualPassing).toBe(0)
      expect(consistency.actualFailing).toBe(3)
    }
  })

  it('不一致的统计返回 consistent: false', () => {
    const content = readFixture('inconsistent-stats.json')
    const result = parsePRDContent(content)

    expect(result.success).toBe(true)
    if (result.success) {
      const consistency = checkStatisticsConsistency(result.data)
      expect(consistency.consistent).toBe(false)
      expect(consistency.actualPassing).toBe(2) // 实际 2 个
      expect(result.data.statistics.passing).toBe(1) // 声明 1 个
    }
  })
})
