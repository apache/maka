import type { PracticeCluster, PracticeCommit, PracticeStats } from '@ggbdpq/console-shared'
import { extractFixScope } from './classify'

/** 所在周的周一（本地时区），返回 YYYY-MM-DD */
function weekStartOf(isoDate: string): string {
  const d = new Date(isoDate)
  const day = (d.getDay() + 6) % 7 // 周一=0
  d.setDate(d.getDate() - day)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day2 = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day2}`
}

function dirnameOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/')
  return idx > 0 ? filePath.slice(0, idx) : filePath
}

/** 聚类累加器：计数 + 最新几条 subject 样本（输入需按时间倒序） */
class ClusterAcc {
  count = 0
  samples: string[] = []
  add(subject: string, maxSamples: number): void {
    this.count += 1
    if (this.samples.length < maxSamples) this.samples.push(subject)
  }
  toCluster(key: string): PracticeCluster {
    return { key, count: this.count, samples: this.samples }
  }
}

function topClusters(
  accs: Map<string, ClusterAcc>,
  limit: number,
): PracticeCluster[] {
  return [...accs.entries()]
    .map(([key, acc]) => acc.toCluster(key))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit)
}

/**
 * 纯聚合：从提交集合算统计。commits 需按作者时间倒序（loadCommits 已保证）。
 * 修复聚类双轨：subject 的 scope + 触及文件目录/文件路径（diff 证据比标题硬）。
 */
export function computeStats(commits: PracticeCommit[]): PracticeStats {
  const byType = { pr: 0, issue: 0, other: 0 }
  const repoAcc = new Map<string, { total: number; byType: { pr: number; issue: number; other: number } }>()
  const weeklyAcc = new Map<string, { total: number; pr: number; issue: number; other: number }>()
  const scopeAcc = new Map<string, ClusterAcc>()
  const dirAcc = new Map<string, ClusterAcc>()
  const fileAcc = new Map<string, ClusterAcc>()

  for (const c of commits) {
    byType[c.type] += 1

    const repo = repoAcc.get(c.repo) ?? { total: 0, byType: { pr: 0, issue: 0, other: 0 } }
    repo.total += 1
    repo.byType[c.type] += 1
    repoAcc.set(c.repo, repo)

    const week = weekStartOf(c.authoredAt)
    const w = weeklyAcc.get(week) ?? { total: 0, pr: 0, issue: 0, other: 0 }
    w.total += 1
    w[c.type] += 1
    weeklyAcc.set(week, w)

    if (c.type === 'issue') {
      const scope = extractFixScope(c.subject)
      if (scope) {
        const acc = scopeAcc.get(scope) ?? new ClusterAcc()
        acc.add(c.subject, 3)
        scopeAcc.set(scope, acc)
      }
      for (const f of c.files) {
        const dir = dirnameOf(f.path)
        const dirCluster = dirAcc.get(dir) ?? new ClusterAcc()
        dirCluster.add(c.subject, 3)
        dirAcc.set(dir, dirCluster)
        const fileCluster = fileAcc.get(f.path) ?? new ClusterAcc()
        fileCluster.add(c.subject, 3)
        fileAcc.set(f.path, fileCluster)
      }
    }
  }

  return {
    total: commits.length,
    byType,
    byRepo: [...repoAcc.entries()]
      .map(([repo, v]) => ({ repo, total: v.total, byType: v.byType }))
      .sort((a, b) => b.total - a.total),
    weekly: [...weeklyAcc.entries()]
      .map(([weekStart, v]) => ({ weekStart, ...v }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    topFixScopes: topClusters(scopeAcc, 10),
    topFixDirs: topClusters(dirAcc, 10),
    topFixFiles: topClusters(fileAcc, 10),
  }
}
