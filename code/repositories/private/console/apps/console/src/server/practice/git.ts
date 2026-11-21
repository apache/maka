import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 执行 git 命令返回 stdout（公司仓库历史大，maxBuffer 放宽到 64MB） */
export async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoPath,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  return stdout
}

export interface BranchRef {
  /** 展示名（远程去掉 origin/ 前缀，与本地同名合并） */
  name: string
  /** 实际 git 引用（git log 直接可用） */
  ref: string
}

/**
 * 列出本地 + 远程分支：展示名去重，同名时优先本地引用。
 * 过滤裸远程引用（refs/remotes/origin）与 HEAD 指针。
 */
export function parseBranchRefs(forEachRefOutput: string): BranchRef[] {
  const byName = new Map<string, string>()
  // 先收远程再收本地：同名时本地引用覆盖
  for (const line of forEachRefOutput.split('\n')) {
    const ref = line.trim()
    if (!ref) continue
    const remote = ref.match(/^refs\/remotes\/([^/]+)\/(.+)$/)
    if (remote && remote[2] !== 'HEAD') {
      if (!byName.has(remote[2] as string)) byName.set(remote[2] as string, ref)
      continue
    }
    if (ref.startsWith('refs/heads/')) {
      byName.set(ref.slice('refs/heads/'.length), ref)
    }
  }
  return [...byName.entries()].map(([name, ref]) => ({ name, ref }))
}

/** 解析分支提交收集（git log --format=%H）输出为 sha 列表 */
export function parseShaList(logOutput: string): string[] {
  return logOutput
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[0-9a-f]{40}$/.test(l))
}

export interface RawCommitDetail {
  sha: string
  authorName: string
  authorEmail: string
  authoredAt: string
  rawSubject: string
  files: Array<{ path: string; insertions: number; deletions: number }>
}

/**
 * 解析 `git log --no-walk --numstat --format=%x01%H%x00%an%x00%ae%x00%ad%x00%s` 输出。
 * 记录以 \x01 开头，元数据字段以 \x00 分隔，其后是 numstat 行（二进制文件为 -\t-\t路径）。
 */
export function parseCommitDetails(output: string): RawCommitDetail[] {
  const details: RawCommitDetail[] = []
  for (const chunk of output.split('\x01')) {
    if (!chunk.trim()) continue
    const lines = chunk.split('\n')
    const meta = (lines[0] ?? '').split('\x00')
    if (meta.length < 5) continue
    const files: RawCommitDetail['files'] = []
    for (const line of lines.slice(1)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
      if (!m) continue
      files.push({
        path: m[3] as string,
        insertions: m[1] === '-' ? 0 : Number(m[1]),
        deletions: m[2] === '-' ? 0 : Number(m[2]),
      })
    }
    details.push({
      sha: meta[0] as string,
      authorName: meta[1] as string,
      authorEmail: meta[2] as string,
      authoredAt: meta[3] as string,
      rawSubject: meta[4] as string,
      files,
    })
  }
  return details
}

/** git log 参数上限保护：sha 分批（Windows 命令行长度约 32k） */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export interface CollectFilter {
  /** git --author 正则（已 OR 连接好的单个表达式或多个表达式） */
  authorPatterns: string[]
  since: string
  until: string
}

/** 收集单个分支引用上满足过滤条件的提交 sha（不含 merge 提交） */
export async function collectBranchShas(
  repoPath: string,
  branchRef: string,
  filter: CollectFilter,
): Promise<string[]> {
  const out = await runGit(repoPath, [
    'log',
    '--format=%H',
    '--no-merges',
    ...filter.authorPatterns.flatMap((a) => ['--author', a]),
    `--since=${filter.since}`,
    `--until=${filter.until}`,
    branchRef,
    '--',
  ])
  return parseShaList(out)
}

/** 批量拉取提交详情（作者 + 作者时间 + 标题 + numstat）；单次调用，sha 分批 */
export async function fetchCommitDetails(repoPath: string, shas: string[]): Promise<RawCommitDetail[]> {
  const all: RawCommitDetail[] = []
  for (const batch of chunk([...shas], 200)) {
    const out = await runGit(repoPath, [
      'log',
      '--no-walk=unsorted',
      '--numstat',
      '--date=iso-strict',
      '--format=%x01%H%x00%an%x00%ae%x00%ad%x00%s',
      ...batch,
    ])
    all.push(...parseCommitDetails(out))
  }
  return all
}

/** 列出仓库分支（本地 + 远程展示名去重，附带实际引用） */
export async function listBranches(repoPath: string): Promise<BranchRef[]> {
  const out = await runGit(repoPath, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
  ])
  return parseBranchRefs(out)
}
