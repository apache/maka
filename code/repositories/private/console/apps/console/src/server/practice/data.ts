import type { PracticeData } from '@ggbdpq/console-shared'
import { getPracticeDb, loadCommits, loadMeta, loadRepoSummaries } from './db'
import { computeStats } from './stats'
import { DEFAULT_WINDOW, PRACTICE_AUTHORS } from './config'

/** 组装前端全量载荷（未同步过时返回空数据 + 默认窗口） */
export function loadPracticeData(): PracticeData {
  const db = getPracticeDb()
  const commits = loadCommits(db)
  const syncedAt = loadMeta(db, 'synced_at')
  const repos = loadRepoSummaries(db)

  const authors: string[] = (() => {
    try {
      const raw = loadMeta(db, 'authors')
      return raw ? (JSON.parse(raw) as string[]) : [...PRACTICE_AUTHORS]
    } catch {
      return [...PRACTICE_AUTHORS]
    }
  })()

  return {
    syncedAt,
    window: {
      since: loadMeta(db, 'window_since') ?? DEFAULT_WINDOW.since,
      until: loadMeta(db, 'window_until') ?? DEFAULT_WINDOW.until,
    },
    authors,
    repos,
    branches: [...new Set(commits.flatMap((c) => c.branches))].sort(),
    commits,
    stats: computeStats(commits),
  }
}
