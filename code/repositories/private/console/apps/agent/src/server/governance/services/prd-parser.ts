/**
 * PRD Parser Service
 * 负责解析 prd.json 文件
 */

import type { PRDDocument, PRDItem, PRDStatistics, PRDPriority } from '@ggbdpq/console-shared'

/**
 * 解析错误类型
 */
export interface PRDParseError {
  readonly type: 'json_parse_error' | 'validation_error'
  readonly message: string
  readonly details?: string
}

/**
 * 解析结果
 */
export type PRDParseResult =
  | { readonly success: true; readonly data: PRDDocument }
  | { readonly success: false; readonly error: PRDParseError }

/**
 * 校验结果
 */
export interface PRDValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
}

/**
 * 判断值是否为有效的 PRDPriority
 */
function isPRDPriority(value: unknown): value is PRDPriority {
  return value === 'P0' || value === 'P1' || value === 'P2'
}

/**
 * 校验单个 PRDItem
 */
function validatePRDItem(item: unknown, index: number): string[] {
  const errors: string[] = []
  const prefix = `items[${index}]`

  if (typeof item !== 'object' || item === null) {
    errors.push(`${prefix}: 必须是对象`)
    return errors
  }

  const obj = item as Record<string, unknown>

  // id 校验
  if (typeof obj['id'] !== 'string' && typeof obj['id'] !== 'number') {
    errors.push(`${prefix}.id: 必须是字符串或数字`)
  }

  // component 校验
  if (typeof obj['component'] !== 'string') {
    errors.push(`${prefix}.component: 必须是字符串`)
  }

  // priority 校验
  if (!isPRDPriority(obj['priority'])) {
    errors.push(`${prefix}.priority: 必须是 "P0"、"P1" 或 "P2"`)
  }

  // steps 校验
  if (!Array.isArray(obj['steps'])) {
    errors.push(`${prefix}.steps: 必须是数组`)
  } else {
    const invalidSteps = obj['steps'].filter((s: unknown) => typeof s !== 'string')
    if (invalidSteps.length > 0) {
      errors.push(`${prefix}.steps: 所有元素必须是字符串`)
    }
  }

  // passes 校验
  if (typeof obj['passes'] !== 'boolean') {
    errors.push(`${prefix}.passes: 必须是布尔值`)
  }

  return errors
}

/**
 * 校验 PRDStatistics
 */
function validatePRDStatistics(stats: unknown): string[] {
  const errors: string[] = []
  const prefix = 'statistics'

  if (typeof stats !== 'object' || stats === null) {
    errors.push(`${prefix}: 必须是对象`)
    return errors
  }

  const obj = stats as Record<string, unknown>

  // total 校验
  if (typeof obj['total'] !== 'number' || !Number.isInteger(obj['total'])) {
    errors.push(`${prefix}.total: 必须是整数`)
  }

  // passing 校验
  if (typeof obj['passing'] !== 'number' || !Number.isInteger(obj['passing'])) {
    errors.push(`${prefix}.passing: 必须是整数`)
  }

  // failing 校验
  if (typeof obj['failing'] !== 'number' || !Number.isInteger(obj['failing'])) {
    errors.push(`${prefix}.failing: 必须是整数`)
  }

  // completion 校验
  if (typeof obj['completion'] !== 'string') {
    errors.push(`${prefix}.completion: 必须是字符串`)
  }

  // blocked_reason 校验
  if (typeof obj['blocked_reason'] !== 'string') {
    errors.push(`${prefix}.blocked_reason: 必须是字符串`)
  }

  return errors
}

/**
 * 校验 PRDDocument 结构
 */
export function validatePRDDocument(data: unknown): PRDValidationResult {
  const errors: string[] = []

  if (typeof data !== 'object' || data === null) {
    return { valid: false, errors: ['根对象必须是 object'] }
  }

  const obj = data as Record<string, unknown>

  // items 校验
  if (!Array.isArray(obj['items'])) {
    errors.push('items: 必须是数组')
  } else {
    for (let i = 0; i < obj['items'].length; i++) {
      errors.push(...validatePRDItem(obj['items'][i], i))
    }
  }

  // statistics 校验：缺失不阻断（运行时可从 items 推导），存在则校验
  if (obj['statistics'] !== undefined) {
    errors.push(...validatePRDStatistics(obj['statistics']))
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * 将原始数据转换为类型安全的 PRDDocument
 * 前置条件：数据已通过校验
 */
function toPRDDocument(data: Record<string, unknown>): PRDDocument {
  const rawItems = data['items'] as unknown[]
  const rawStats = data['statistics'] as Record<string, unknown> | undefined

  const items: PRDItem[] = rawItems.map((item) => {
    const obj = item as Record<string, unknown>
    return {
      id: String(obj['id']),
      component: obj['component'] as string,
      priority: obj['priority'] as PRDPriority,
      steps: obj['steps'] as string[],
      passes: obj['passes'] as boolean,
    }
  })

  // statistics 缺失时从 items 诚实推导
  const total = items.length
  const passing = items.filter((item) => item.passes).length
  const statistics: PRDStatistics = rawStats
    ? {
        total: rawStats['total'] as number,
        passing: rawStats['passing'] as number,
        failing: rawStats['failing'] as number,
        completion: rawStats['completion'] as string,
        blocked_reason: rawStats['blocked_reason'] as string,
      }
    : {
        total,
        passing,
        failing: total - passing,
        completion: total > 0 ? `${Math.round((passing / total) * 100)}%` : '0%',
        blocked_reason: '',
      }

  return { items, statistics }
}

/**
 * 解析 prd.json 内容
 * @param content JSON 字符串内容
 * @returns 解析结果
 */
export function parsePRDContent(content: string): PRDParseResult {
  // Step 1: JSON 解析
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch (e) {
    return {
      success: false,
      error: {
        type: 'json_parse_error',
        message: 'JSON 解析失败',
        details: e instanceof Error ? e.message : String(e),
      },
    }
  }

  // Step 2: 结构校验
  const validation = validatePRDDocument(data)
  if (!validation.valid) {
    return {
      success: false,
      error: {
        type: 'validation_error',
        message: '结构校验失败',
        details: validation.errors.join('; '),
      },
    }
  }

  // Step 3: 类型转换
  const document = toPRDDocument(data as Record<string, unknown>)

  return { success: true, data: document }
}

/**
 * 获取下一个应执行的 PRD item
 * 规则：passes === false 的 item 中，优先级 P0 > P1 > P2，同优先级选最小 id
 */
export function getNextPRDItem(document: PRDDocument): PRDItem | null {
  const pendingItems = document.items.filter((item) => !item.passes)

  if (pendingItems.length === 0) {
    return null
  }

  // 按优先级和 id 排序
  const priorityOrder: Record<PRDPriority, number> = { P0: 0, P1: 1, P2: 2 }

  const sorted = [...pendingItems].sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority]
    if (priorityDiff !== 0) return priorityDiff
    return a.id.localeCompare(b.id)
  })

  return sorted[0] ?? null
}

/**
 * 检查 statistics 是否与 items 一致
 * 注意：此函数仅用于检测不一致，不用于裁决
 */
export function checkStatisticsConsistency(
  document: PRDDocument
): { consistent: boolean; actualPassing: number; actualFailing: number } {
  const actualPassing = document.items.filter((item) => item.passes).length
  const actualFailing = document.items.filter((item) => !item.passes).length

  return {
    consistent:
      document.statistics.passing === actualPassing &&
      document.statistics.failing === actualFailing &&
      document.statistics.total === document.items.length,
    actualPassing,
    actualFailing,
  }
}
