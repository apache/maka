/**
 * AuditService 测试
 *
 * 覆盖：
 * - PRD ID 提取
 * - 链路分组
 * - 完整性判断
 * - 链路构建
 * - 报告生成
 * - 一致性验证
 */

import { describe, it, expect } from 'vitest'
import {
  extractPrdIdFromProgress,
  extractPrdIdFromCommit,
  groupProgressByPrdId,
  groupCommitsByPrdId,
  determineIntegrity,
  buildTrailForPrd,
  buildAuditTrails,
  generateIntegrityReport,
  filterTrailsByIntegrity,
  getIncompleteTrails,
  validateTrailConsistency,
  validateAllTrailsConsistency,
} from '@/server/governance/services'
import type {
  PRDItem,
  PRDDocument,
  ProgressEntry,
  GitCommit,
  AuditTrail,
} from '@ggbdpq/console-shared'

// ===== 测试数据 =====

function createPrdItem(id: string, passes: boolean): PRDItem {
  return {
    id,
    component: `Component-${id}`,
    priority: 'P0',
    steps: ['step1', 'step2'],
    passes,
  }
}

function createProgressEntry(prdId: string): ProgressEntry {
  return {
    datetime: new Date('2026-01-12'),
    prdId,
    component: `Component-${prdId}`,
    priority: 'P0',
    what: 'Did something',
    why: 'For a reason',
    typecheckResult: 'exit 0',
    commitMessage: 'feat: test',
    next: 'Next PRD',
    rawContent: '## 2026-01-12',
  }
}

function createGitCommit(message: string): GitCommit {
  return {
    sha: 'abc123',
    author: 'Test User',
    date: new Date('2026-01-12'),
    message,
    files: ['file.ts'],
  }
}

// ===== 测试 =====

describe('extractPrdIdFromProgress', () => {
  it('应从 progress 条目提取 PRD ID', () => {
    const entry = createProgressEntry('PRD-01')
    expect(extractPrdIdFromProgress(entry)).toBe('PRD-01')
  })

  it('prdId 为空时应返回 null', () => {
    const entry: ProgressEntry = {
      ...createProgressEntry('PRD-01'),
      prdId: '',
    }
    expect(extractPrdIdFromProgress(entry)).toBe('')
  })
})

describe('extractPrdIdFromCommit', () => {
  it('应从 scope 中提取 PRD ID', () => {
    const commit = createGitCommit('feat(PRD-01): add feature')
    expect(extractPrdIdFromCommit(commit)).toBe('PRD-01')
  })

  it('应从 message 中提取 PRD ID', () => {
    const commit = createGitCommit('implement PRD-02 feature')
    expect(extractPrdIdFromCommit(commit)).toBe('PRD-02')
  })

  it('应处理小写 PRD ID', () => {
    const commit = createGitCommit('feat(prd-03): test')
    expect(extractPrdIdFromCommit(commit)).toBe('PRD-03')
  })

  it('没有 PRD ID 时应返回 null', () => {
    const commit = createGitCommit('feat: update readme')
    expect(extractPrdIdFromCommit(commit)).toBeNull()
  })
})

describe('groupProgressByPrdId', () => {
  it('应按 PRD ID 分组', () => {
    const entries = [
      createProgressEntry('PRD-01'),
      createProgressEntry('PRD-01'),
      createProgressEntry('PRD-02'),
    ]

    const groups = groupProgressByPrdId(entries)

    expect(groups.size).toBe(2)
    expect(groups.get('PRD-01')).toHaveLength(2)
    expect(groups.get('PRD-02')).toHaveLength(1)
  })

  it('空数组应返回空 Map', () => {
    const groups = groupProgressByPrdId([])
    expect(groups.size).toBe(0)
  })
})

describe('groupCommitsByPrdId', () => {
  it('应按 PRD ID 分组', () => {
    const commits = [
      createGitCommit('feat(PRD-01): change 1'),
      createGitCommit('fix(PRD-01): fix bug'),
      createGitCommit('feat(PRD-02): add feature'),
    ]

    const groups = groupCommitsByPrdId(commits)

    expect(groups.size).toBe(2)
    expect(groups.get('PRD-01')).toHaveLength(2)
    expect(groups.get('PRD-02')).toHaveLength(1)
  })

  it('没有 PRD ID 的 commit 应被忽略', () => {
    const commits = [
      createGitCommit('feat(PRD-01): change'),
      createGitCommit('chore: update deps'),
    ]

    const groups = groupCommitsByPrdId(commits)

    expect(groups.size).toBe(1)
    expect(groups.get('PRD-01')).toHaveLength(1)
  })
})

describe('determineIntegrity', () => {
  it('有 progress 和 commit 且 passes 为 true 应返回 complete', () => {
    const prdItem = createPrdItem('PRD-01', true)
    const progress = [createProgressEntry('PRD-01')]
    const commits = [createGitCommit('feat(PRD-01): done')]

    expect(determineIntegrity(prdItem, progress, commits)).toBe('complete')
  })

  it('有 progress 和 commit 但 passes 为 false 应返回 partial', () => {
    const prdItem = createPrdItem('PRD-01', false)
    const progress = [createProgressEntry('PRD-01')]
    const commits = [createGitCommit('feat(PRD-01): wip')]

    expect(determineIntegrity(prdItem, progress, commits)).toBe('partial')
  })

  it('有 progress 但无 commit 应返回 partial', () => {
    const prdItem = createPrdItem('PRD-01', true)
    const progress = [createProgressEntry('PRD-01')]

    expect(determineIntegrity(prdItem, progress, [])).toBe('partial')
  })

  it('有 commit 但无 progress 应返回 partial', () => {
    const prdItem = createPrdItem('PRD-01', true)
    const commits = [createGitCommit('feat(PRD-01): done')]

    expect(determineIntegrity(prdItem, [], commits)).toBe('partial')
  })

  it('无 progress 也无 commit 应返回 broken', () => {
    const prdItem = createPrdItem('PRD-01', false)

    expect(determineIntegrity(prdItem, [], [])).toBe('broken')
  })
})

describe('buildTrailForPrd', () => {
  it('应构建完整的审计链路', () => {
    const prdItem = createPrdItem('PRD-01', true)
    const progress = [createProgressEntry('PRD-01')]
    const commits = [createGitCommit('feat(PRD-01): done')]

    const trail = buildTrailForPrd(prdItem, progress, commits)

    expect(trail.prdItem).toBe(prdItem)
    expect(trail.progressEntries).toEqual(progress)
    expect(trail.gitCommits).toEqual(commits)
    expect(trail.integrity).toBe('complete')
  })
})

describe('buildAuditTrails', () => {
  it('应为所有 PRD 构建链路', () => {
    const prdDocument: PRDDocument = {
      items: [createPrdItem('PRD-01', true), createPrdItem('PRD-02', false)],
      statistics: {
        total: 2,
        passing: 1,
        failing: 1,
        completion: '50%',
        blocked_reason: '',
      },
    }

    const progress = [createProgressEntry('PRD-01')]
    const commits = [createGitCommit('feat(PRD-01): done')]

    const result = buildAuditTrails(prdDocument, progress, commits)

    expect(result.trails).toHaveLength(2)
    expect(result.trails[0]?.integrity).toBe('complete')
    expect(result.trails[1]?.integrity).toBe('broken')
  })

  it('应生成警告当 PRD 完成但链路不完整', () => {
    const prdDocument: PRDDocument = {
      items: [createPrdItem('PRD-01', true)],
      statistics: {
        total: 1,
        passing: 1,
        failing: 0,
        completion: '100%',
        blocked_reason: '',
      },
    }

    const result = buildAuditTrails(prdDocument, [], [])

    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.some((w) => w.includes('PRD-01'))).toBe(true)
  })

  it('应检测孤立的 progress 条目', () => {
    const prdDocument: PRDDocument = {
      items: [createPrdItem('PRD-01', false)],
      statistics: {
        total: 1,
        passing: 0,
        failing: 1,
        completion: '0%',
        blocked_reason: '',
      },
    }

    // PRD-99 不在 prdDocument 中
    const progress = [createProgressEntry('PRD-99')]

    const result = buildAuditTrails(prdDocument, progress, [])

    expect(result.warnings.some((w) => w.includes('PRD-99'))).toBe(true)
  })

  it('应检测孤立的 commits', () => {
    const prdDocument: PRDDocument = {
      items: [createPrdItem('PRD-01', false)],
      statistics: {
        total: 1,
        passing: 0,
        failing: 1,
        completion: '0%',
        blocked_reason: '',
      },
    }

    // PRD-99 不在 prdDocument 中
    const commits = [createGitCommit('feat(PRD-99): orphan')]

    const result = buildAuditTrails(prdDocument, [], commits)

    expect(result.warnings.some((w) => w.includes('PRD-99'))).toBe(true)
  })
})

describe('generateIntegrityReport', () => {
  it('应正确统计各状态数量', () => {
    const trails: AuditTrail[] = [
      buildTrailForPrd(
        createPrdItem('PRD-01', true),
        [createProgressEntry('PRD-01')],
        [createGitCommit('feat(PRD-01): done')]
      ),
      buildTrailForPrd(
        createPrdItem('PRD-02', false),
        [createProgressEntry('PRD-02')],
        []
      ),
      buildTrailForPrd(createPrdItem('PRD-03', false), [], []),
    ]

    const report = generateIntegrityReport(trails)

    expect(report.totalPRDs).toBe(3)
    expect(report.completeTrails).toBe(1)
    expect(report.partialTrails).toBe(1)
    expect(report.brokenTrails).toBe(1)
    expect(report.completionRate).toBe('33%')
  })

  it('空链路应返回 0%', () => {
    const report = generateIntegrityReport([])

    expect(report.totalPRDs).toBe(0)
    expect(report.completionRate).toBe('0%')
  })

  it('全部完整应返回 100%', () => {
    const trails: AuditTrail[] = [
      buildTrailForPrd(
        createPrdItem('PRD-01', true),
        [createProgressEntry('PRD-01')],
        [createGitCommit('feat(PRD-01): done')]
      ),
    ]

    const report = generateIntegrityReport(trails)

    expect(report.completionRate).toBe('100%')
  })
})

describe('filterTrailsByIntegrity', () => {
  it('应过滤指定完整性状态的链路', () => {
    const trails: AuditTrail[] = [
      buildTrailForPrd(
        createPrdItem('PRD-01', true),
        [createProgressEntry('PRD-01')],
        [createGitCommit('feat(PRD-01): done')]
      ),
      buildTrailForPrd(createPrdItem('PRD-02', false), [], []),
    ]

    const complete = filterTrailsByIntegrity(trails, 'complete')
    const broken = filterTrailsByIntegrity(trails, 'broken')

    expect(complete).toHaveLength(1)
    expect(broken).toHaveLength(1)
  })
})

describe('getIncompleteTrails', () => {
  it('应返回非完整的链路', () => {
    const trails: AuditTrail[] = [
      buildTrailForPrd(
        createPrdItem('PRD-01', true),
        [createProgressEntry('PRD-01')],
        [createGitCommit('feat(PRD-01): done')]
      ),
      buildTrailForPrd(
        createPrdItem('PRD-02', false),
        [createProgressEntry('PRD-02')],
        []
      ),
      buildTrailForPrd(createPrdItem('PRD-03', false), [], []),
    ]

    const incomplete = getIncompleteTrails(trails)

    expect(incomplete).toHaveLength(2)
  })
})

describe('validateTrailConsistency', () => {
  it('PRD 完成且链路完整应一致', () => {
    const trail = buildTrailForPrd(
      createPrdItem('PRD-01', true),
      [createProgressEntry('PRD-01')],
      [createGitCommit('feat(PRD-01): done')]
    )

    const { consistent, issues } = validateTrailConsistency(trail)

    expect(consistent).toBe(true)
    expect(issues).toHaveLength(0)
  })

  it('PRD 完成但链路断裂应不一致', () => {
    const trail = buildTrailForPrd(createPrdItem('PRD-01', true), [], [])

    const { consistent, issues } = validateTrailConsistency(trail)

    expect(consistent).toBe(false)
    expect(issues.length).toBeGreaterThan(0)
  })

  it('PRD 未完成但链路完整应不一致', () => {
    const trail: AuditTrail = {
      prdItem: createPrdItem('PRD-01', false),
      progressEntries: [createProgressEntry('PRD-01')],
      gitCommits: [createGitCommit('feat(PRD-01): done')],
      integrity: 'complete', // 强制设置为 complete 来模拟不一致
    }

    const { consistent, issues } = validateTrailConsistency(trail)

    expect(consistent).toBe(false)
    expect(issues.some((i) => i.includes('未标记为完成'))).toBe(true)
  })
})

describe('validateAllTrailsConsistency', () => {
  it('全部一致应返回 true', () => {
    const trails: AuditTrail[] = [
      buildTrailForPrd(
        createPrdItem('PRD-01', true),
        [createProgressEntry('PRD-01')],
        [createGitCommit('feat(PRD-01): done')]
      ),
      buildTrailForPrd(createPrdItem('PRD-02', false), [], []),
    ]

    const { allConsistent, issues } = validateAllTrailsConsistency(trails)

    expect(allConsistent).toBe(true)
    expect(issues).toHaveLength(0)
  })

  it('有不一致应返回 false', () => {
    const trails: AuditTrail[] = [
      buildTrailForPrd(createPrdItem('PRD-01', true), [], []), // 不一致
    ]

    const { allConsistent, issues } = validateAllTrailsConsistency(trails)

    expect(allConsistent).toBe(false)
    expect(issues.length).toBeGreaterThan(0)
  })
})
