/**
 * 合规性检查服务
 *
 * 实现以下合规性规则检查：
 * 1. one-prd-per-commit: 每次 commit 只能关联一个 PRD
 * 2. typecheck-gate: pnpm typecheck 必须通过
 * 3. append-only-progress: progress.txt 只能追加，不能修改或删除历史记录
 * 4. commit-convention: Git commit message 必须符合 Angular 规范
 */

import type {
  ComplianceResult,
  ComplianceStatus,
  ComplianceViolation,
  ComplianceRule,
  ComplianceSeverity,
} from '@ggbdpq/console-shared'

// ===== 规则名称常量 =====

export const RULE_ONE_PRD_PER_COMMIT = 'one-prd-per-commit' as const
export const RULE_TYPECHECK_GATE = 'typecheck-gate' as const
export const RULE_APPEND_ONLY_PROGRESS = 'append-only-progress' as const
export const RULE_COMMIT_CONVENTION = 'commit-convention' as const

export type ComplianceRuleName =
  | typeof RULE_ONE_PRD_PER_COMMIT
  | typeof RULE_TYPECHECK_GATE
  | typeof RULE_APPEND_ONLY_PROGRESS
  | typeof RULE_COMMIT_CONVENTION

// ===== 规则定义 =====

const SEVERITY_ERROR: ComplianceSeverity = 'error'
const SEVERITY_WARNING: ComplianceSeverity = 'warning'

export const COMPLIANCE_RULES: Record<ComplianceRuleName, ComplianceRule> = {
  [RULE_ONE_PRD_PER_COMMIT]: {
    id: RULE_ONE_PRD_PER_COMMIT,
    name: '单 PRD 提交规则',
    description: '每次 Git commit 只能关联一个 PRD',
    severity: SEVERITY_ERROR,
  },
  [RULE_TYPECHECK_GATE]: {
    id: RULE_TYPECHECK_GATE,
    name: 'TypeCheck 门禁',
    description: 'pnpm typecheck 必须通过才能标记 PRD 为完成',
    severity: SEVERITY_ERROR,
  },
  [RULE_APPEND_ONLY_PROGRESS]: {
    id: RULE_APPEND_ONLY_PROGRESS,
    name: 'Progress 只追加规则',
    description: 'progress.txt 只能追加新记录，不能修改或删除历史记录',
    severity: SEVERITY_ERROR,
  },
  [RULE_COMMIT_CONVENTION]: {
    id: RULE_COMMIT_CONVENTION,
    name: 'Commit 规范',
    description: 'Git commit message 必须符合 Angular 规范',
    severity: SEVERITY_WARNING,
  },
}

// ===== 辅助函数 =====

/**
 * 创建合规性检查结果
 */
export function createComplianceResult(
  rule: ComplianceRuleName,
  status: ComplianceStatus,
  violations: ComplianceViolation[] = [],
  details?: string
): ComplianceResult {
  const result: ComplianceResult = {
    rule: COMPLIANCE_RULES[rule],
    status,
    violations,
  }

  if (details !== undefined) {
    return { ...result, details }
  }

  return result
}

/**
 * 创建违规记录
 */
export function createViolation(
  message: string,
  location?: string,
  suggestion?: string
): ComplianceViolation {
  const violation: ComplianceViolation = { message }

  if (location !== undefined) {
    Object.assign(violation, { location })
  }

  if (suggestion !== undefined) {
    Object.assign(violation, { suggestion })
  }

  return violation
}

// ===== 规则检查器 =====

/**
 * 检查 commit message 是否只关联一个 PRD
 * @param commitMessage commit message
 * @param prdIds progress 中提取的 PRD IDs
 * @returns 合规性检查结果
 */
export function checkOnePrdPerCommit(
  commitMessage: string,
  prdIds: string[]
): ComplianceResult {
  // 如果没有 PRD IDs，无法验证
  if (prdIds.length === 0) {
    return createComplianceResult(
      RULE_ONE_PRD_PER_COMMIT,
      'unverifiable',
      [],
      '未找到关联的 PRD ID'
    )
  }

  // 如果只有一个 PRD ID，通过
  if (prdIds.length === 1) {
    const prdId = prdIds[0]
    return createComplianceResult(
      RULE_ONE_PRD_PER_COMMIT,
      'passed',
      [],
      prdId ? `关联 PRD: ${prdId}` : '关联 PRD: 未知'
    )
  }

  // 多个 PRD ID，违规
  const violations = [
    createViolation(
      `单次提交关联了 ${prdIds.length} 个 PRD: ${prdIds.join(', ')}`,
      commitMessage,
      '每次提交应只关联一个 PRD'
    ),
  ]

  return createComplianceResult(
    RULE_ONE_PRD_PER_COMMIT,
    'failed',
    violations,
    `违规：关联了 ${prdIds.length} 个 PRD`
  )
}

/**
 * 检查 typecheck 是否通过
 * @param typecheckResult typecheck 结果文本
 * @returns 合规性检查结果
 */
export function checkTypecheckGate(typecheckResult: string): ComplianceResult {
  // 空结果，无法验证
  if (!typecheckResult.trim()) {
    return createComplianceResult(
      RULE_TYPECHECK_GATE,
      'unverifiable',
      [],
      '未找到 typecheck 结果'
    )
  }

  // 检查是否包含成功标识
  const passPatterns = [
    /exit\s*(code)?:?\s*0/i,
    /passed/i,
    /success/i,
    /no\s+errors?/i,
  ]

  const isPass = passPatterns.some((pattern) => pattern.test(typecheckResult))

  if (isPass) {
    return createComplianceResult(RULE_TYPECHECK_GATE, 'passed', [], 'typecheck 通过')
  }

  // 检查是否包含失败标识
  const failPatterns = [/exit\s*(code)?:?\s*[1-9]/i, /error/i, /failed/i]

  const isFail = failPatterns.some((pattern) => pattern.test(typecheckResult))

  if (isFail) {
    return createComplianceResult(
      RULE_TYPECHECK_GATE,
      'failed',
      [createViolation('typecheck 未通过', typecheckResult, '修复类型错误后重新运行')],
      'typecheck 失败'
    )
  }

  // 无法确定结果
  return createComplianceResult(
    RULE_TYPECHECK_GATE,
    'unverifiable',
    [],
    '无法解析 typecheck 结果'
  )
}

/**
 * 检查 progress 是否只追加
 * @param previousContent 之前的 progress 内容
 * @param currentContent 当前的 progress 内容
 * @returns 合规性检查结果
 */
export function checkAppendOnlyProgress(
  previousContent: string,
  currentContent: string
): ComplianceResult {
  // 如果没有之前的内容，无法验证
  if (!previousContent.trim()) {
    return createComplianceResult(
      RULE_APPEND_ONLY_PROGRESS,
      'unverifiable',
      [],
      '没有之前的 progress 内容用于比较'
    )
  }

  // 检查当前内容是否以之前的内容开头（允许首尾空白差异）
  const normalizedPrevious = previousContent.trim()
  const normalizedCurrent = currentContent.trim()

  // 检查之前的内容是否完整保留在当前内容中
  // 注意：progress.txt 是向头部追加新内容，所以检查逻辑需要调整
  // 实际上，新内容会在文件头部，旧内容在尾部

  // 检查之前的内容是否存在于当前内容的某个位置
  if (normalizedCurrent.includes(normalizedPrevious)) {
    return createComplianceResult(
      RULE_APPEND_ONLY_PROGRESS,
      'passed',
      [],
      '历史记录完整保留'
    )
  }

  // 进一步检查：按条目比较
  // 提取条目（以 ## 开头的块）
  const extractEntries = (content: string): string[] => {
    const entries = content.split(/(?=## \d{4}-\d{2}-\d{2})/)
    return entries.filter((e) => e.trim().startsWith('##'))
  }

  const previousEntries = extractEntries(normalizedPrevious)
  const currentEntries = extractEntries(normalizedCurrent)

  // 检查之前的每个条目是否都存在于当前内容中
  const missingEntries: string[] = []

  for (const prevEntry of previousEntries) {
    const prevEntryNormalized = prevEntry.trim()
    const found = currentEntries.some((currEntry) =>
      currEntry.trim().includes(prevEntryNormalized.substring(0, 100))
    )
    if (!found) {
      // 提取条目标题作为标识
      const titleMatch = prevEntry.match(/## (\d{4}-\d{2}-\d{2}[^\n]*)/)
      const title = titleMatch ? titleMatch[1] : '未知条目'
      if (title) {
        missingEntries.push(title)
      }
    }
  }

  if (missingEntries.length === 0) {
    return createComplianceResult(
      RULE_APPEND_ONLY_PROGRESS,
      'passed',
      [],
      '历史记录完整保留'
    )
  }

  // 有条目被删除或修改
  const violations = missingEntries.map((title) =>
    createViolation(
      `历史条目被修改或删除: ${title}`,
      'progress.txt',
      '只能追加新内容，不能修改或删除历史记录'
    )
  )

  return createComplianceResult(
    RULE_APPEND_ONLY_PROGRESS,
    'failed',
    violations,
    `发现 ${missingEntries.length} 个历史条目被修改或删除`
  )
}

/**
 * 检查 commit message 是否符合 Angular 规范
 * 格式：type(scope): description
 * @param commitMessage commit message
 * @returns 合规性检查结果
 */
export function checkCommitConvention(commitMessage: string): ComplianceResult {
  // 空消息，无法验证
  if (!commitMessage.trim()) {
    return createComplianceResult(
      RULE_COMMIT_CONVENTION,
      'unverifiable',
      [],
      '未找到 commit message'
    )
  }

  // Angular 规范的类型
  const validTypes = [
    'feat', // 新功能
    'fix', // 修复
    'docs', // 文档
    'style', // 格式
    'refactor', // 重构
    'perf', // 性能
    'test', // 测试
    'build', // 构建
    'ci', // CI
    'chore', // 杂项
    'revert', // 回滚
  ]

  // 匹配 Angular commit 格式：type(scope): description 或 type: description
  const angularPattern = new RegExp(
    `^(${validTypes.join('|')})(\\([^)]+\\))?:\\s*.+`,
    'i'
  )

  if (angularPattern.test(commitMessage.trim())) {
    return createComplianceResult(
      RULE_COMMIT_CONVENTION,
      'passed',
      [],
      '符合 Angular commit 规范'
    )
  }

  // 不符合规范
  return createComplianceResult(
    RULE_COMMIT_CONVENTION,
    'failed',
    [
      createViolation(
        `commit message 不符合 Angular 规范: "${commitMessage}"`,
        commitMessage,
        '使用格式: type(scope): description，如 feat(core): add new feature'
      ),
    ],
    '不符合 Angular commit 规范'
  )
}

// ===== 批量检查 =====

export interface ComplianceCheckContext {
  /** commit message */
  commitMessage?: string
  /** 关联的 PRD IDs */
  prdIds?: string[]
  /** typecheck 结果 */
  typecheckResult?: string
  /** 之前的 progress 内容 */
  previousProgress?: string
  /** 当前的 progress 内容 */
  currentProgress?: string
}

/**
 * 执行所有合规性检查
 * @param context 检查上下文
 * @returns 所有规则的检查结果
 */
export function checkAllCompliance(
  context: ComplianceCheckContext
): ComplianceResult[] {
  const results: ComplianceResult[] = []

  // 检查 one-prd-per-commit
  if (context.commitMessage !== undefined && context.prdIds !== undefined) {
    results.push(checkOnePrdPerCommit(context.commitMessage, context.prdIds))
  }

  // 检查 typecheck-gate
  if (context.typecheckResult !== undefined) {
    results.push(checkTypecheckGate(context.typecheckResult))
  }

  // 检查 append-only-progress
  if (context.previousProgress !== undefined && context.currentProgress !== undefined) {
    results.push(checkAppendOnlyProgress(context.previousProgress, context.currentProgress))
  }

  // 检查 commit-convention
  if (context.commitMessage !== undefined) {
    results.push(checkCommitConvention(context.commitMessage))
  }

  return results
}

/**
 * 获取合规性检查摘要
 * @param results 检查结果列表
 * @returns 摘要信息
 */
export function getComplianceSummary(results: ComplianceResult[]): {
  passed: number
  failed: number
  unverifiable: number
  hasError: boolean
  hasWarning: boolean
} {
  let passed = 0
  let failed = 0
  let unverifiable = 0
  let hasError = false
  let hasWarning = false

  for (const result of results) {
    switch (result.status) {
      case 'passed':
        passed++
        break
      case 'failed':
        failed++
        if (result.rule.severity === 'error') {
          hasError = true
        } else if (result.rule.severity === 'warning') {
          hasWarning = true
        }
        break
      case 'unverifiable':
        unverifiable++
        break
    }
  }

  return { passed, failed, unverifiable, hasError, hasWarning }
}
