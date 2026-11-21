/**
 * 核心类型定义测试
 * 验证类型定义的正确性
 */
import { describe, it, expect } from 'vitest'
import type {
  PRDItem,
  PRDDocument,
  PRDStatistics,
  PRDPriority,
  ProgressEntry,
  Iteration,
  Milestone,
  ComplianceResult,
  ComplianceRule,
  AuditTrail,
  GitCommit,
  GitAvailability,
  GitQueryResult,
  SpecDocument,
} from '@ggbdpq/console-shared'

describe('PRD Types', () => {
  it('PRDItem 类型定义正确', () => {
    const item: PRDItem = {
      id: 'PRD-00',
      component: 'BlockingDecision',
      priority: 'P0',
      steps: ['step 1', 'step 2'],
      passes: false,
    }

    expect(item.id).toBe('PRD-00')
    expect(item.passes).toBe(false)
    expect(item.steps).toHaveLength(2)
  })

  it('PRDStatistics 类型定义正确', () => {
    const stats: PRDStatistics = {
      total: 13,
      passing: 2,
      failing: 11,
      completion: '15%',
      blocked_reason: '',
    }

    expect(stats.total).toBe(13)
    expect(stats.completion).toBe('15%')
  })

  it('PRDDocument 类型定义正确', () => {
    const doc: PRDDocument = {
      items: [
        {
          id: 'PRD-00',
          component: 'Test',
          priority: 'P0',
          steps: [],
          passes: true,
        },
      ],
      statistics: {
        total: 1,
        passing: 1,
        failing: 0,
        completion: '100%',
        blocked_reason: '',
      },
    }

    expect(doc.items).toHaveLength(1)
    expect(doc.statistics.completion).toBe('100%')
  })

  it('PRDPriority 类型约束正确', () => {
    const priorities: PRDPriority[] = ['P0', 'P1', 'P2']
    expect(priorities).toHaveLength(3)
  })
})

describe('Progress Types', () => {
  it('ProgressEntry 类型定义正确', () => {
    const entry: ProgressEntry = {
      datetime: new Date('2026-01-12'),
      prdId: 'PRD-00',
      component: 'BlockingDecision',
      priority: 'P0',
      what: '完成了某项工作',
      why: '因为这样做更好',
      typecheckResult: 'passed',
      commitMessage: 'docs(core): decide runtime',
      next: 'PRD-01',
      rawContent: '原始内容',
    }

    expect(entry.prdId).toBe('PRD-00')
    expect(entry.datetime).toBeInstanceOf(Date)
  })
})

describe('Iteration Types', () => {
  it('Iteration 类型定义正确', () => {
    const iteration: Iteration = {
      prdItem: {
        id: 'PRD-00',
        component: 'Test',
        priority: 'P0',
        steps: [],
        passes: true,
      },
      progressEntry: null,
      gitCommit: null,
      isValid: false,
      invalidReason: '缺少 progress 记录',
    }

    expect(iteration.isValid).toBe(false)
    expect(iteration.invalidReason).toBe('缺少 progress 记录')
  })
})

describe('Milestone Types', () => {
  it('Milestone 类型定义正确', () => {
    const milestone: Milestone = {
      name: 'P0 Tasks',
      groupBy: 'priority',
      prdItems: [],
      statistics: {
        total: 5,
        completed: 2,
        completion: '40%',
      },
    }

    expect(milestone.groupBy).toBe('priority')
    expect(milestone.statistics.completion).toBe('40%')
  })
})

describe('Compliance Types', () => {
  it('ComplianceResult 类型定义正确', () => {
    const rule: ComplianceRule = {
      id: 'one-prd-per-commit',
      name: '单 PRD 提交规则',
      description: '每次 Git commit 只能关联一个 PRD',
      severity: 'error',
    }
    const result: ComplianceResult = {
      rule,
      status: 'passed',
      violations: [],
      details: '所有 commit 都只对应一个 PRD',
    }

    expect(result.status).toBe('passed')
  })

  it('ComplianceRule 类型约束正确', () => {
    const rule: ComplianceRule = {
      id: 'typecheck-gate',
      name: 'TypeCheck 门禁',
      description: 'pnpm typecheck 必须通过',
      severity: 'error',
    }
    expect(rule.id).toBe('typecheck-gate')
    expect(rule.severity).toBe('error')
  })
})

describe('Audit Types', () => {
  it('AuditTrail 类型定义正确', () => {
    const trail: AuditTrail = {
      prdItem: {
        id: 'PRD-00',
        component: 'Test',
        priority: 'P0',
        steps: [],
        passes: true,
      },
      progressEntries: [],
      gitCommits: [],
      integrity: 'broken',
      integrityIssues: ['缺少 progress 记录', '缺少 git commit'],
    }

    expect(trail.integrity).toBe('broken')
    expect(trail.integrityIssues).toHaveLength(2)
  })
})

describe('Git Types', () => {
  it('GitCommit 类型定义正确', () => {
    const commit: GitCommit = {
      sha: 'abc123',
      message: 'docs(core): test commit',
      author: 'Test User',
      date: new Date(),
      files: ['file1.ts', 'file2.ts'],
    }

    expect(commit.sha).toBe('abc123')
    expect(commit.files).toHaveLength(2)
  })

  it('GitAvailability 类型定义正确', () => {
    const available: GitAvailability = { available: true }
    const unavailable: GitAvailability = {
      available: false,
      reason: 'git_unavailable',
    }

    expect(available.available).toBe(true)
    expect(unavailable.available).toBe(false)
    if (!unavailable.available) {
      expect(unavailable.reason).toBe('git_unavailable')
    }
  })

  it('GitQueryResult 类型定义正确', () => {
    const success: GitQueryResult<string> = {
      status: 'success',
      data: 'test data',
    }
    const unverifiable: GitQueryResult<string> = {
      status: 'unverifiable',
      reason: 'Git 不可用',
    }

    expect(success.status).toBe('success')
    if (success.status === 'success') {
      expect(success.data).toBe('test data')
    }
    expect(unverifiable.status).toBe('unverifiable')
  })
})

describe('Spec Types', () => {
  it('SpecDocument 类型定义正确', () => {
    const spec: SpecDocument = {
      name: 'ops-panel',
      path: '.kiro/specs/ops-panel',
      requirements: '# Requirements',
      design: '# Design',
      tasks: null,
      completeness: {
        hasRequirements: true,
        hasDesign: true,
        hasTasks: false,
      },
    }

    expect(spec.name).toBe('ops-panel')
    expect(spec.tasks).toBeNull()
    expect(spec.completeness.hasTasks).toBe(false)
  })
})
