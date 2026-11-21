import { describe, expect, it } from 'vitest'
import type { PracticeCommit } from '@ggbdpq/console-shared'
import { computeStats } from './stats'

function commit(partial: Partial<PracticeCommit> & Pick<PracticeCommit, 'sha' | 'type' | 'authoredAt'>): PracticeCommit {
  const { sha, type, authoredAt, files, ...rest } = partial
  return {
    sha,
    shortSha: sha.slice(0, 8),
    repo: 'workbench',
    branches: ['main'],
    subject: '',
    rawSubject: '',
    type,
    authorName: '关天豪',
    authorEmail: '802165@clife.cn',
    authoredAt,
    insertions: 10,
    deletions: 2,
    filesChanged: files?.length ?? 0,
    tapdBug: null,
    files: files ?? [],
    ...rest,
  }
}

describe('computeStats', () => {
  const commits: PracticeCommit[] = [
    // 2026-09-07 是周一；9-9 属于该周
    commit({ sha: 'a'.repeat(40), type: 'issue', authoredAt: '2026-09-09T10:00:00+08:00', subject: 'fix(workbench): 修复导出重复', files: [
      { path: 'src/pages/workbench/export.tsx', insertions: 5, deletions: 2 },
      { path: 'src/services/export.ts', insertions: 1, deletions: 0 },
    ] }),
    commit({ sha: 'b'.repeat(40), type: 'issue', authoredAt: '2026-09-08T10:00:00+08:00', subject: 'fix(workbench): 导出列缺失', files: [
      { path: 'src/pages/workbench/export.tsx', insertions: 3, deletions: 1 },
    ] }),
    commit({ sha: 'c'.repeat(40), type: 'pr', authoredAt: '2026-09-07T10:00:00+08:00', subject: 'feat(home): 新增轮播' }),
    commit({ sha: 'd'.repeat(40), type: 'other', authoredAt: '2026-08-25T10:00:00+08:00', subject: 'chore: 升级依赖' }),
    // 上一周（8-25、8-28 属于 08-24 那周；9-7/8/9 属于 09-07 那周）
    commit({ sha: 'e'.repeat(40), type: 'issue', authoredAt: '2026-08-28T10:00:00+08:00', subject: 'fix(report): 报告截断', repo: 'advisor', files: [
      { path: 'src/pages/report/detail.tsx', insertions: 2, deletions: 1 },
    ] }),
  ]

  it('总量与类型计数', () => {
    const stats = computeStats(commits)
    expect(stats.total).toBe(5)
    expect(stats.byType).toEqual({ pr: 1, issue: 3, other: 1 })
  })

  it('按仓库聚合', () => {
    const stats = computeStats(commits)
    const workbench = stats.byRepo.find((r) => r.repo === 'workbench')
    const advisor = stats.byRepo.find((r) => r.repo === 'advisor')
    expect(workbench?.total).toBe(4)
    expect(advisor?.total).toBe(1)
  })

  it('按周一为起点的自然周聚合', () => {
    const stats = computeStats(commits)
    const weeks = stats.weekly.map((w) => w.weekStart)
    expect(weeks).toEqual(['2026-08-24', '2026-09-07'])
    const sepWeek = stats.weekly.find((w) => w.weekStart === '2026-09-07')
    expect(sepWeek).toMatchObject({ total: 3, pr: 1, issue: 2, other: 0 })
  })

  it('修复 scope 聚类带样本', () => {
    const stats = computeStats(commits)
    const wb = stats.topFixScopes.find((c) => c.key === 'workbench')
    expect(wb?.count).toBe(2)
    expect(wb?.samples).toEqual(['fix(workbench): 修复导出重复', 'fix(workbench): 导出列缺失'])
  })

  it('修复目录与文件聚类：同一文件被反复修复排前', () => {
    const stats = computeStats(commits)
    expect(stats.topFixFiles[0]).toMatchObject({ key: 'src/pages/workbench/export.tsx', count: 2 })
    expect(stats.topFixDirs[0]).toMatchObject({ key: 'src/pages/workbench', count: 2 })
  })

  it('空输入返回零值统计', () => {
    const stats = computeStats([])
    expect(stats.total).toBe(0)
    expect(stats.weekly).toEqual([])
    expect(stats.topFixFiles).toEqual([])
  })
})
