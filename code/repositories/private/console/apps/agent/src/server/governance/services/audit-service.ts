/**
 * 审计链路构建服务
 *
 * 实现 PRD ↔ progress ↔ commit 链路构建
 * 统计链路完整性：complete/partial/broken
 */

import type {
  PRDItem,
  PRDDocument,
  ProgressEntry,
  GitCommit,
  AuditTrail,
  AuditIntegrity,
  IntegrityReport,
} from '@ggbdpq/console-shared'

// ===== 类型定义 =====

/**
 * 审计链路构建结果
 */
export interface AuditBuildResult {
  /** 构建的审计链路列表 */
  readonly trails: readonly AuditTrail[]

  /** 完整性报告 */
  readonly report: IntegrityReport

  /** 警告信息 */
  readonly warnings: readonly string[]
}

/**
 * 链路匹配器选项
 */
export interface TrailMatcherOptions {
  /** 是否启用模糊匹配 */
  readonly fuzzyMatch?: boolean

  /** 是否包含未匹配的 progress 条目 */
  readonly includeOrphans?: boolean
}

// ===== 辅助函数 =====

/**
 * 从 progress 条目中提取 PRD ID
 */
export function extractPrdIdFromProgress(entry: ProgressEntry): string | null {
  return entry.prdId ?? null
}

/**
 * 从 commit message 中提取 PRD ID
 * 支持格式：feat(PRD-01): ... 或 commit message 中包含 PRD-XX
 */
export function extractPrdIdFromCommit(commit: GitCommit): string | null {
  const message = commit.message

  // 匹配 scope 中的 PRD ID: feat(PRD-01): ...
  const scopeMatch = message.match(/\(([Pp][Rr][Dd]-\d+)\)/)
  if (scopeMatch?.[1]) {
    return scopeMatch[1].toUpperCase()
  }

  // 匹配 message 中的 PRD ID
  const messageMatch = message.match(/[Pp][Rr][Dd]-\d+/)
  if (messageMatch?.[0]) {
    return messageMatch[0].toUpperCase()
  }

  return null
}

/**
 * 按 PRD ID 分组 progress 条目
 */
export function groupProgressByPrdId(
  entries: readonly ProgressEntry[]
): Map<string, ProgressEntry[]> {
  const groups = new Map<string, ProgressEntry[]>()

  for (const entry of entries) {
    const prdId = extractPrdIdFromProgress(entry)
    if (prdId) {
      const existing = groups.get(prdId) ?? []
      existing.push(entry)
      groups.set(prdId, existing)
    }
  }

  return groups
}

/**
 * 按 PRD ID 分组 git commits
 */
export function groupCommitsByPrdId(
  commits: readonly GitCommit[]
): Map<string, GitCommit[]> {
  const groups = new Map<string, GitCommit[]>()

  for (const commit of commits) {
    const prdId = extractPrdIdFromCommit(commit)
    if (prdId) {
      const existing = groups.get(prdId) ?? []
      existing.push(commit)
      groups.set(prdId, existing)
    }
  }

  return groups
}

/**
 * 确定链路完整性
 */
export function determineIntegrity(
  prdItem: PRDItem,
  progressEntries: readonly ProgressEntry[],
  gitCommits: readonly GitCommit[]
): AuditIntegrity {
  const hasPrd = true // 因为 prdItem 存在
  const hasProgress = progressEntries.length > 0
  const hasCommit = gitCommits.length > 0

  // 完整：PRD + progress + commit 都有
  if (hasPrd && hasProgress && hasCommit) {
    // 进一步检查：PRD passes 状态应该与链路状态一致
    if (prdItem.passes) {
      return 'complete'
    }
    // PRD 未完成但有 progress 和 commit，可能是部分完成
    return 'partial'
  }

  // 部分：有 PRD 和 progress，但缺少 commit
  if (hasPrd && hasProgress && !hasCommit) {
    return 'partial'
  }

  // 部分：有 PRD 和 commit，但缺少 progress
  if (hasPrd && !hasProgress && hasCommit) {
    return 'partial'
  }

  // 断裂：只有 PRD，没有 progress 也没有 commit
  return 'broken'
}

/**
 * 构建单个 PRD 的审计链路
 */
export function buildTrailForPrd(
  prdItem: PRDItem,
  progressEntries: readonly ProgressEntry[],
  gitCommits: readonly GitCommit[]
): AuditTrail {
  const integrity = determineIntegrity(prdItem, progressEntries, gitCommits)

  return {
    prdItem,
    progressEntries,
    gitCommits,
    integrity,
  }
}

/**
 * 构建所有 PRD 的审计链路
 */
export function buildAuditTrails(
  prdDocument: PRDDocument,
  progressEntries: readonly ProgressEntry[],
  gitCommits: readonly GitCommit[],
  _options?: TrailMatcherOptions
): AuditBuildResult {
  const warnings: string[] = []
  const trails: AuditTrail[] = []

  // 按 PRD ID 分组 progress 和 commits
  const progressGroups = groupProgressByPrdId(progressEntries)
  const commitGroups = groupCommitsByPrdId(gitCommits)

  // 为每个 PRD item 构建链路
  for (const prdItem of prdDocument.items) {
    const prdProgress = progressGroups.get(prdItem.id) ?? []
    const prdCommits = commitGroups.get(prdItem.id) ?? []

    const trail = buildTrailForPrd(prdItem, prdProgress, prdCommits)
    trails.push(trail)

    // 添加警告
    if (prdItem.passes && trail.integrity === 'broken') {
      warnings.push(`${prdItem.id}: 标记为完成但缺少 progress 和 commit 记录`)
    }

    if (prdItem.passes && trail.integrity === 'partial') {
      warnings.push(`${prdItem.id}: 标记为完成但链路不完整`)
    }
  }

  // 检查孤立的 progress 条目（没有对应 PRD 的）
  const prdIds = new Set(prdDocument.items.map((item) => item.id))
  for (const [prdId] of progressGroups) {
    if (!prdIds.has(prdId)) {
      warnings.push(`发现孤立的 progress 条目，PRD ID: ${prdId}`)
    }
  }

  // 检查孤立的 commits
  for (const [prdId] of commitGroups) {
    if (!prdIds.has(prdId)) {
      warnings.push(`发现孤立的 commit，PRD ID: ${prdId}`)
    }
  }

  // 生成完整性报告
  const report = generateIntegrityReport(trails)

  return { trails, report, warnings }
}

/**
 * 生成完整性报告
 */
export function generateIntegrityReport(
  trails: readonly AuditTrail[]
): IntegrityReport {
  let completeCount = 0
  let partialCount = 0
  let brokenCount = 0

  for (const trail of trails) {
    switch (trail.integrity) {
      case 'complete':
        completeCount++
        break
      case 'partial':
        partialCount++
        break
      case 'broken':
        brokenCount++
        break
    }
  }

  const totalPRDs = trails.length
  const completionRate = totalPRDs > 0 ? Math.round((completeCount / totalPRDs) * 100) : 0

  return {
    totalPRDs,
    completeTrails: completeCount,
    partialTrails: partialCount,
    brokenTrails: brokenCount,
    completionRate: `${completionRate}%`,
  }
}

/**
 * 获取指定完整性状态的链路
 */
export function filterTrailsByIntegrity(
  trails: readonly AuditTrail[],
  integrity: AuditIntegrity
): readonly AuditTrail[] {
  return trails.filter((trail) => trail.integrity === integrity)
}

/**
 * 获取需要关注的链路（非完整）
 */
export function getIncompleteTrails(
  trails: readonly AuditTrail[]
): readonly AuditTrail[] {
  return trails.filter((trail) => trail.integrity !== 'complete')
}

/**
 * 验证链路一致性
 * 检查 PRD passes 状态与链路完整性是否一致
 */
export function validateTrailConsistency(
  trail: AuditTrail
): { consistent: boolean; issues: readonly string[] } {
  const issues: string[] = []

  // 如果 PRD 标记为完成，链路应该是 complete
  if (trail.prdItem.passes && trail.integrity !== 'complete') {
    issues.push(
      `PRD ${trail.prdItem.id} 标记为完成，但链路状态为 ${trail.integrity}`
    )
  }

  // 如果 PRD 未完成，但有完整链路，可能是状态更新遗漏
  if (!trail.prdItem.passes && trail.integrity === 'complete') {
    issues.push(
      `PRD ${trail.prdItem.id} 未标记为完成，但已有完整的执行链路`
    )
  }

  return {
    consistent: issues.length === 0,
    issues,
  }
}

/**
 * 批量验证所有链路一致性
 */
export function validateAllTrailsConsistency(
  trails: readonly AuditTrail[]
): { allConsistent: boolean; issues: readonly string[] } {
  const allIssues: string[] = []

  for (const trail of trails) {
    const { issues } = validateTrailConsistency(trail)
    allIssues.push(...issues)
  }

  return {
    allConsistent: allIssues.length === 0,
    issues: allIssues,
  }
}
