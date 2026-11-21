/**
 * ComplianceCheckerService 测试
 *
 * 覆盖：
 * - one-prd-per-commit 规则
 * - typecheck-gate 规则
 * - append-only-progress 规则
 * - commit-convention 规则
 * - 批量检查
 * - 摘要统计
 */

import { describe, it, expect } from 'vitest'
import {
  RULE_ONE_PRD_PER_COMMIT,
  RULE_TYPECHECK_GATE,
  RULE_APPEND_ONLY_PROGRESS,
  RULE_COMMIT_CONVENTION,
  COMPLIANCE_RULES,
  checkOnePrdPerCommit,
  checkTypecheckGate,
  checkAppendOnlyProgress,
  checkCommitConvention,
  checkAllCompliance,
  getComplianceSummary,
  createComplianceResult,
  createViolation,
} from '@/server/governance/services'

describe('合规性规则定义', () => {
  it('应包含所有规则定义', () => {
    expect(COMPLIANCE_RULES[RULE_ONE_PRD_PER_COMMIT]).toBeDefined()
    expect(COMPLIANCE_RULES[RULE_TYPECHECK_GATE]).toBeDefined()
    expect(COMPLIANCE_RULES[RULE_APPEND_ONLY_PROGRESS]).toBeDefined()
    expect(COMPLIANCE_RULES[RULE_COMMIT_CONVENTION]).toBeDefined()
  })

  it('规则应包含必要字段', () => {
    const rule = COMPLIANCE_RULES[RULE_ONE_PRD_PER_COMMIT]
    expect(rule.id).toBe(RULE_ONE_PRD_PER_COMMIT)
    expect(rule.name).toBeDefined()
    expect(rule.description).toBeDefined()
    expect(rule.severity).toBeDefined()
  })
})

describe('createComplianceResult', () => {
  it('应创建合规性结果', () => {
    const result = createComplianceResult(RULE_ONE_PRD_PER_COMMIT, 'passed', [], '测试详情')

    expect(result.rule.id).toBe(RULE_ONE_PRD_PER_COMMIT)
    expect(result.status).toBe('passed')
    expect(result.violations).toHaveLength(0)
    expect(result.details).toBe('测试详情')
  })
})

describe('createViolation', () => {
  it('应创建违规记录', () => {
    const violation = createViolation('违规信息', 'file.ts', '建议修改')

    expect(violation.message).toBe('违规信息')
    expect(violation.location).toBe('file.ts')
    expect(violation.suggestion).toBe('建议修改')
  })

  it('可选字段应为 undefined', () => {
    const violation = createViolation('违规信息')

    expect(violation.message).toBe('违规信息')
    expect(violation.location).toBeUndefined()
    expect(violation.suggestion).toBeUndefined()
  })
})

describe('checkOnePrdPerCommit', () => {
  it('单个 PRD ID 应通过', () => {
    const result = checkOnePrdPerCommit('feat(core): add feature', ['PRD-01'])

    expect(result.status).toBe('passed')
    expect(result.violations).toHaveLength(0)
  })

  it('多个 PRD ID 应失败', () => {
    const result = checkOnePrdPerCommit('feat: big change', ['PRD-01', 'PRD-02'])

    expect(result.status).toBe('failed')
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]?.message).toContain('2 个 PRD')
  })

  it('没有 PRD ID 应不可验证', () => {
    const result = checkOnePrdPerCommit('feat: change', [])

    expect(result.status).toBe('unverifiable')
    expect(result.details).toContain('未找到')
  })
})

describe('checkTypecheckGate', () => {
  it('exit 0 应通过', () => {
    const result = checkTypecheckGate('pnpm typecheck: exit 0')

    expect(result.status).toBe('passed')
  })

  it('exit code: 0 应通过', () => {
    const result = checkTypecheckGate('typecheck exit code: 0')

    expect(result.status).toBe('passed')
  })

  it('passed 应通过', () => {
    const result = checkTypecheckGate('Typecheck passed!')

    expect(result.status).toBe('passed')
  })

  it('no errors 应通过', () => {
    const result = checkTypecheckGate('no errors found')

    expect(result.status).toBe('passed')
  })

  it('exit 1 应失败', () => {
    const result = checkTypecheckGate('typecheck exit: 1')

    expect(result.status).toBe('failed')
    expect(result.violations).toHaveLength(1)
  })

  it('error 应失败', () => {
    const result = checkTypecheckGate('src/index.ts: error TS2345')

    expect(result.status).toBe('failed')
  })

  it('空结果应不可验证', () => {
    const result = checkTypecheckGate('')

    expect(result.status).toBe('unverifiable')
  })

  it('无法解析的结果应不可验证', () => {
    const result = checkTypecheckGate('running typecheck...')

    expect(result.status).toBe('unverifiable')
  })
})

describe('checkAppendOnlyProgress', () => {
  const previousContent = `## 2026-01-10 PRD-01 完成

### 相关 PRD
- id: PRD-01

### What（做了什么）
测试内容`

  it('追加新内容应通过', () => {
    const currentContent = `## 2026-01-11 PRD-02 完成

### 相关 PRD
- id: PRD-02

---

## 2026-01-10 PRD-01 完成

### 相关 PRD
- id: PRD-01

### What（做了什么）
测试内容`

    const result = checkAppendOnlyProgress(previousContent, currentContent)

    expect(result.status).toBe('passed')
  })

  it('完全相同的内容应通过', () => {
    const result = checkAppendOnlyProgress(previousContent, previousContent)

    expect(result.status).toBe('passed')
  })

  it('删除历史内容应失败', () => {
    const currentContent = `## 2026-01-11 PRD-02 完成

### 相关 PRD
- id: PRD-02`

    const result = checkAppendOnlyProgress(previousContent, currentContent)

    expect(result.status).toBe('failed')
    expect(result.violations.length).toBeGreaterThan(0)
  })

  it('没有之前内容应不可验证', () => {
    const result = checkAppendOnlyProgress('', 'new content')

    expect(result.status).toBe('unverifiable')
  })
})

describe('checkCommitConvention', () => {
  it('feat(scope): desc 应通过', () => {
    const result = checkCommitConvention('feat(core): add new feature')

    expect(result.status).toBe('passed')
  })

  it('fix: desc 应通过', () => {
    const result = checkCommitConvention('fix: resolve bug')

    expect(result.status).toBe('passed')
  })

  it('docs(readme): desc 应通过', () => {
    const result = checkCommitConvention('docs(readme): update documentation')

    expect(result.status).toBe('passed')
  })

  it('chore(deps): desc 应通过', () => {
    const result = checkCommitConvention('chore(deps): update dependencies')

    expect(result.status).toBe('passed')
  })

  it('所有有效类型应通过', () => {
    const validTypes = [
      'feat',
      'fix',
      'docs',
      'style',
      'refactor',
      'perf',
      'test',
      'build',
      'ci',
      'chore',
      'revert',
    ]

    for (const type of validTypes) {
      const result = checkCommitConvention(`${type}: test message`)
      expect(result.status).toBe('passed')
    }
  })

  it('无效格式应失败', () => {
    const result = checkCommitConvention('Update readme')

    expect(result.status).toBe('failed')
    expect(result.violations).toHaveLength(1)
  })

  it('无效类型应失败', () => {
    const result = checkCommitConvention('invalid(core): test')

    expect(result.status).toBe('failed')
  })

  it('空消息应不可验证', () => {
    const result = checkCommitConvention('')

    expect(result.status).toBe('unverifiable')
  })

  it('大写类型应通过（不区分大小写）', () => {
    const result = checkCommitConvention('FEAT(core): add feature')

    expect(result.status).toBe('passed')
  })
})

describe('checkAllCompliance', () => {
  it('应检查所有提供的规则', () => {
    const results = checkAllCompliance({
      commitMessage: 'feat(core): add feature',
      prdIds: ['PRD-01'],
      typecheckResult: 'exit 0',
    })

    // 应包含 one-prd-per-commit、typecheck-gate、commit-convention 三个检查
    expect(results).toHaveLength(3)
  })

  it('应跳过未提供的检查', () => {
    const results = checkAllCompliance({
      commitMessage: 'feat: test',
    })

    // 只有 commit-convention，因为 prdIds 未提供
    expect(results).toHaveLength(1)
    expect(results[0]?.rule.id).toBe(RULE_COMMIT_CONVENTION)
  })

  it('应包含所有检查当所有参数都提供时', () => {
    const results = checkAllCompliance({
      commitMessage: 'feat(core): add feature',
      prdIds: ['PRD-01'],
      typecheckResult: 'exit 0',
      previousProgress: '## old content',
      currentProgress: '## new content\n## old content',
    })

    // 应包含所有四个检查
    expect(results).toHaveLength(4)
  })
})

describe('getComplianceSummary', () => {
  it('应正确统计通过数', () => {
    const results = [
      createComplianceResult(RULE_ONE_PRD_PER_COMMIT, 'passed'),
      createComplianceResult(RULE_TYPECHECK_GATE, 'passed'),
    ]

    const summary = getComplianceSummary(results)

    expect(summary.passed).toBe(2)
    expect(summary.failed).toBe(0)
    expect(summary.unverifiable).toBe(0)
  })

  it('应正确统计失败数', () => {
    const results = [
      createComplianceResult(RULE_ONE_PRD_PER_COMMIT, 'failed'),
      createComplianceResult(RULE_TYPECHECK_GATE, 'passed'),
    ]

    const summary = getComplianceSummary(results)

    expect(summary.passed).toBe(1)
    expect(summary.failed).toBe(1)
  })

  it('应正确统计不可验证数', () => {
    const results = [
      createComplianceResult(RULE_ONE_PRD_PER_COMMIT, 'unverifiable'),
      createComplianceResult(RULE_TYPECHECK_GATE, 'unverifiable'),
    ]

    const summary = getComplianceSummary(results)

    expect(summary.unverifiable).toBe(2)
  })

  it('应正确识别是否有错误', () => {
    const results = [
      createComplianceResult(RULE_ONE_PRD_PER_COMMIT, 'failed'), // severity: error
      createComplianceResult(RULE_COMMIT_CONVENTION, 'passed'),
    ]

    const summary = getComplianceSummary(results)

    expect(summary.hasError).toBe(true)
    expect(summary.hasWarning).toBe(false)
  })

  it('应正确识别是否有警告', () => {
    const results = [
      createComplianceResult(RULE_ONE_PRD_PER_COMMIT, 'passed'),
      createComplianceResult(RULE_COMMIT_CONVENTION, 'failed'), // severity: warning
    ]

    const summary = getComplianceSummary(results)

    expect(summary.hasError).toBe(false)
    expect(summary.hasWarning).toBe(true)
  })

  it('空结果应全为 0', () => {
    const summary = getComplianceSummary([])

    expect(summary.passed).toBe(0)
    expect(summary.failed).toBe(0)
    expect(summary.unverifiable).toBe(0)
    expect(summary.hasError).toBe(false)
    expect(summary.hasWarning).toBe(false)
  })
})
