/**
 * Progress Parser Service
 * 负责解析 progress.txt 文件
 */

import type { ProgressEntry, PRDPriority } from '@ggbdpq/console-shared'

/**
 * 解析后的 Progress 条目（部分字段可能缺失）
 */
export interface ParsedProgressEntry {
  /** 记录时间（可能为 null 如果无法解析） */
  readonly datetime: Date | null

  /** 关联的 PRD ID（可能为 null） */
  readonly prdId: string | null

  /** 关联的组件（可能为 null） */
  readonly component: string | null

  /** 优先级（可能为 null） */
  readonly priority: PRDPriority | null

  /** 做了什么（可能为空字符串） */
  readonly what: string

  /** 为什么这样做（可能为空字符串） */
  readonly why: string

  /** typecheck 结果（可能为空字符串） */
  readonly typecheckResult: string

  /** git commit message（可能为空字符串） */
  readonly commitMessage: string

  /** 下一条计划执行的 PRD（可能为空字符串） */
  readonly next: string

  /** 原始文本内容 */
  readonly rawContent: string
}

/**
 * 解析结果
 */
export interface ProgressParseResult {
  /** 成功解析的条目 */
  readonly entries: readonly ParsedProgressEntry[]

  /** 警告信息（如格式不规范） */
  readonly warnings: readonly string[]
}

/**
 * 将 ParsedProgressEntry 转换为 ProgressEntry
 * 只转换所有必要字段都存在的条目
 */
export function toProgressEntry(parsed: ParsedProgressEntry): ProgressEntry | null {
  if (
    parsed.datetime === null ||
    parsed.prdId === null ||
    parsed.component === null ||
    parsed.priority === null
  ) {
    return null
  }

  return {
    datetime: parsed.datetime,
    prdId: parsed.prdId,
    component: parsed.component,
    priority: parsed.priority,
    what: parsed.what,
    why: parsed.why,
    typecheckResult: parsed.typecheckResult,
    commitMessage: parsed.commitMessage,
    next: parsed.next,
    rawContent: parsed.rawContent,
  }
}

/**
 * 解析日期时间字符串
 * 支持格式：2026-01-12、2026-01-12T10:30:00
 */
function parseDateTime(text: string): Date | null {
  // 尝试匹配日期格式 YYYY-MM-DD
  const dateMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!dateMatch) {
    return null
  }

  const year = parseInt(dateMatch[1]!, 10)
  const month = parseInt(dateMatch[2]!, 10) - 1 // JavaScript 月份从 0 开始
  const day = parseInt(dateMatch[3]!, 10)

  // 尝试匹配时间格式 HH:MM:SS
  const timeMatch = text.match(/(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]!, 10)
    const minute = parseInt(timeMatch[2]!, 10)
    const second = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0
    return new Date(year, month, day, hour, minute, second)
  }

  return new Date(year, month, day)
}

/**
 * 解析 PRD 相关信息
 * 从 "### 相关 PRD" 部分提取 id、component、priority
 */
function parsePRDInfo(content: string): {
  prdId: string | null
  component: string | null
  priority: PRDPriority | null
} {
  let prdId: string | null = null
  let component: string | null = null
  let priority: PRDPriority | null = null

  // 匹配 id
  const idMatch = content.match(/- id:\s*(.+)/i)
  if (idMatch) {
    prdId = idMatch[1]!.trim()
  }

  // 匹配 component
  const componentMatch = content.match(/- component:\s*(.+)/i)
  if (componentMatch) {
    component = componentMatch[1]!.trim()
  }

  // 匹配 priority
  const priorityMatch = content.match(/- priority:\s*(P[012])/i)
  if (priorityMatch) {
    priority = priorityMatch[1]!.toUpperCase() as PRDPriority
  }

  return { prdId, component, priority }
}

/**
 * 提取 section 内容
 */
function extractSection(content: string, sectionName: string): string {
  // 匹配 ### sectionName 或 ### sectionName（...）
  const regex = new RegExp(
    `### ${sectionName}[^\\n]*\\n([\\s\\S]*?)(?=### |## |$)`,
    'i'
  )
  const match = content.match(regex)
  return match ? match[1]!.trim() : ''
}

/**
 * 解析单个 progress 条目
 */
function parseEntry(rawContent: string): ParsedProgressEntry {
  // 解析日期时间（从标题 ## YYYY-MM-DD 中提取）
  const titleMatch = rawContent.match(/## (\d{4}-\d{2}-\d{2})[^\n]*/)
  const datetime = titleMatch ? parseDateTime(titleMatch[1]!) : null

  // 解析 PRD 相关信息
  const { prdId, component, priority } = parsePRDInfo(rawContent)

  // 提取各 section 内容
  const what = extractSection(rawContent, 'What（做了什么）') ||
    extractSection(rawContent, 'What')

  const why = extractSection(rawContent, 'Why（为什么这样做）') ||
    extractSection(rawContent, 'Why')

  const typecheckResult = extractSection(rawContent, 'typecheck 结果') ||
    extractSection(rawContent, 'typecheck')

  // 提取 commit message
  let commitMessage = extractSection(rawContent, 'Git 提交') ||
    extractSection(rawContent, 'Git commit')
  // 如果是多行，取第一行非空内容
  if (commitMessage.includes('\n')) {
    const lines = commitMessage.split('\n').filter((l) => l.trim())
    commitMessage = lines[0] ?? ''
  }

  // 提取 next
  const nextMatch = rawContent.match(/Next:\s*(?:PRD\s+)?(.+)/i)
  const next = nextMatch ? nextMatch[1]!.trim() : ''

  return {
    datetime,
    prdId,
    component,
    priority,
    what,
    why,
    typecheckResult,
    commitMessage,
    next,
    rawContent,
  }
}

/**
 * 将 progress.txt 内容分割为多个条目
 */
function splitEntries(content: string): string[] {
  // 按 ## YYYY-MM-DD 分割
  const entries: string[] = []
  const pattern = /(?=## \d{4}-\d{2}-\d{2})/g

  const parts = content.split(pattern)
  for (const part of parts) {
    const trimmed = part.trim()
    // 跳过空内容和非条目内容（如顶部的 "### 下一步计划"）
    if (trimmed && trimmed.startsWith('## ')) {
      entries.push(trimmed)
    }
  }

  return entries
}

/**
 * 解析 progress.txt 内容
 * @param content progress.txt 文件内容
 * @returns 解析结果
 */
export function parseProgressContent(content: string): ProgressParseResult {
  const warnings: string[] = []

  // 空内容
  if (!content.trim()) {
    return { entries: [], warnings: [] }
  }

  // 分割条目
  const rawEntries = splitEntries(content)

  if (rawEntries.length === 0) {
    warnings.push('未找到符合格式的 progress 条目')
    return { entries: [], warnings }
  }

  // 解析每个条目
  const entries: ParsedProgressEntry[] = []

  for (let i = 0; i < rawEntries.length; i++) {
    const rawContent = rawEntries[i]!
    const entry = parseEntry(rawContent)

    // 检查必要字段
    if (entry.datetime === null) {
      warnings.push(`条目 ${i + 1}: 无法解析日期时间`)
    }
    if (entry.prdId === null) {
      warnings.push(`条目 ${i + 1}: 未找到 PRD ID`)
    }

    entries.push(entry)
  }

  return { entries, warnings }
}

/**
 * 获取完整的 ProgressEntry 列表
 * 过滤掉字段缺失的条目
 */
export function getValidProgressEntries(
  result: ProgressParseResult
): readonly ProgressEntry[] {
  return result.entries
    .map(toProgressEntry)
    .filter((entry): entry is ProgressEntry => entry !== null)
}
