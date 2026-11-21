import type { PracticeCommit, PracticeType } from '@ggbdpq/console-shared'
import { PRACTICE_REPOS, PRACTICE_AUTHORS, DEFAULT_WINDOW } from './config'
import { classifyCommit, cleanSubject, extractTapdBug } from './classify'
import {
  collectBranchShas,
  fetchCommitDetails,
  listBranches,
  runGit,
  type CollectFilter,
} from './git'
import { getPracticeDb, saveSyncedPayload, type SyncedPayload } from './db'

export interface SyncOptions {
  since?: string
  until?: string
}

export interface PracticeRepoResult {
  name: string
  path: string
  commits: number
  error: string | null
}

export interface SyncResult {
  window: { since: string; until: string }
  perRepo: PracticeRepoResult[]
  commits: PracticeCommit[]
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code?: string }).code === 'ENOENT'
}

/** 日期 +1 天（本地时区安全）：git --until 是开区间，含当天需补足 */
function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y as number, (m as number) - 1, (d as number) + 1)
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${mm}-${dd}`
}

/**
 * 同步单个仓库：
 * 1. 列分支（本地+远程展示名去重）→ 2. 逐分支收集窗口内作者提交 sha → 3. 批量拉详情+numstat。
 * 只扫含目标作者提交的分支，把 400+ 分支的扫描面缩到实际有提交的几十个。
 */
async function collectRepo(
  repo: { name: string; path: string },
  filter: CollectFilter,
): Promise<PracticeCommit[]> {
  const branches = await listBranches(repo.path)
  const shasByBranch = new Map<string, string[]>()
  for (const branch of branches) {
    const shas = await collectBranchShas(repo.path, branch.ref, filter)
    if (shas.length > 0) shasByBranch.set(branch.name, shas)
  }
  if (shasByBranch.size === 0) return []

  const branchBySha = new Map<string, string[]>()
  for (const [branch, shas] of shasByBranch) {
    for (const sha of shas) {
      const list = branchBySha.get(sha) ?? []
      list.push(branch)
      branchBySha.set(sha, list)
    }
  }

  const details = await fetchCommitDetails(repo.path, [...branchBySha.keys()])
  return details.map((d) => {
    const subject = cleanSubject(d.rawSubject)
    const type: PracticeType = classifyCommit(d.rawSubject)
    const files = d.files
    return {
      sha: d.sha,
      shortSha: d.sha.slice(0, 8),
      repo: repo.name,
      branches: (branchBySha.get(d.sha) ?? []).sort(),
      subject,
      rawSubject: d.rawSubject,
      type,
      authorName: d.authorName,
      authorEmail: d.authorEmail,
      authoredAt: d.authoredAt,
      insertions: files.reduce((s, f) => s + f.insertions, 0),
      deletions: files.reduce((s, f) => s + f.deletions, 0),
      filesChanged: files.length,
      tapdBug: extractTapdBug(d.rawSubject),
      files,
    }
  })
}

/** 全量同步所有配置仓库并落库；单仓库失败不阻断其余仓库（错误记入 repo_sync） */
export async function syncPractice(opts: SyncOptions = {}): Promise<SyncResult> {
  const since = opts.since ?? DEFAULT_WINDOW.since
  const until = opts.until ?? DEFAULT_WINDOW.until
  // 窗口语义为含首尾；git --until 开区间，传 until+1 天
  const filter: CollectFilter = { authorPatterns: [...PRACTICE_AUTHORS], since, until: nextDay(until) }

  const perRepo: PracticeRepoResult[] = []
  const commits: PracticeCommit[] = []

  for (const repo of PRACTICE_REPOS) {
    try {
      // 先探活：目录不存在 / 不是 git 仓库直接记错误，不逐分支失败
      await runGit(repo.path, ['rev-parse', '--git-dir'])
      const repoCommits = await collectRepo(repo, filter)
      commits.push(...repoCommits)
      perRepo.push({ name: repo.name, path: repo.path, commits: repoCommits.length, error: null })
    } catch (err) {
      const message = isEnoent(err)
        ? '目录不存在或不可访问'
        : err instanceof Error
          ? err.message
          : '未知错误'
      perRepo.push({ name: repo.name, path: repo.path, commits: 0, error: message })
    }
  }

  const syncedAt = new Date().toISOString()
  const db = getPracticeDb()
  const payload: SyncedPayload = {
    window: { since, until },
    authors: [...PRACTICE_AUTHORS],
    repos: perRepo,
    commits,
  }
  saveSyncedPayload(db, payload, syncedAt)

  return { window: { since, until }, perRepo, commits }
}
