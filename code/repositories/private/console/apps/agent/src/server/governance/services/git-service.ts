/**
 * Git 信息读取服务
 *
 * 基于 PRD-00 运行时决策（本地 Node 后端 + Vite 前端），
 * 实现 git 信息读取（commit 列表/单个 commit/文件内容）。
 *
 * 核心原则：无法获取时返回可验证状态（unverifiable）而不是编造。
 */

import type { GitCommit, GitFile } from '@ggbdpq/console-shared'

// ===== 类型定义 =====

/** Git 查询结果的基础类型 */
export type GitQueryResult<T> =
  | { success: true; data: T }
  | { success: false; reason: string; unverifiable: true }

/** Git 执行器接口（用于依赖注入和测试） */
export interface GitExecutor {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>
  isAvailable(): Promise<boolean>
}

/** Git 服务接口 */
export interface IGitService {
  /** 检查 git 是否可用 */
  isAvailable(): Promise<boolean>

  /** 获取 commit 列表 */
  getCommits(limit?: number): Promise<GitQueryResult<GitCommit[]>>

  /** 获取单个 commit 详情 */
  getCommit(sha: string): Promise<GitQueryResult<GitCommit>>

  /** 获取指定 commit 的文件内容 */
  getFileAtCommit(sha: string, filePath: string): Promise<GitQueryResult<string>>

  /** 获取当前文件内容 */
  getCurrentFileContent(filePath: string): Promise<GitQueryResult<string>>

  /** 获取指定 commit 的改动文件列表 */
  getFilesInCommit(sha: string): Promise<GitQueryResult<GitFile[]>>

  /** 获取当前分支名 */
  getCurrentBranch(): Promise<GitQueryResult<string>>

  /** 获取仓库根目录 */
  getRepoRoot(): Promise<GitQueryResult<string>>
}

// ===== 工具函数 =====

/**
 * 创建不可验证结果
 * 当 git 不可用或查询失败时使用
 */
export function createUnverifiableResult<T>(reason: string): GitQueryResult<T> {
  return { success: false, reason, unverifiable: true }
}

/**
 * 创建成功结果
 */
export function createSuccessResult<T>(data: T): GitQueryResult<T> {
  return { success: true, data }
}

/**
 * 类型守卫：检查结果是否成功
 */
export function isGitQuerySuccess<T>(
  result: GitQueryResult<T>
): result is { success: true; data: T } {
  return result.success === true
}

/**
 * 安全获取数据，失败时返回 undefined
 */
export function getGitQueryData<T>(result: GitQueryResult<T>): T | undefined {
  return isGitQuerySuccess(result) ? result.data : undefined
}

/**
 * 解析 git log 输出行
 * 格式：sha|author|date|message
 */
export function parseGitLogLine(line: string): GitCommit | null {
  const parts = line.split('|')
  if (parts.length < 4) return null

  const [sha, author, dateStr, ...messageParts] = parts
  const message = messageParts.join('|') // message 中可能含有 |

  if (sha === undefined || author === undefined || dateStr === undefined) return null

  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return null

  return {
    sha: sha.trim(),
    author: author.trim(),
    date,
    message: message.trim(),
  }
}

// ===== Mock Git Service（用于浏览器环境和测试） =====

/**
 * Mock Git Service
 *
 * 用于：
 * - 浏览器环境（无法直接执行 git 命令）
 * - 单元测试（可控的测试数据）
 *
 * 可通过 setMockData 设置模拟数据
 */
export class MockGitService implements IGitService {
  private available: boolean = true
  private commits: GitCommit[] = []
  private fileContents: Map<string, string> = new Map()
  private branch: string = 'main'
  private repoRoot: string = '/mock/repo'
  private commitFiles: Map<string, GitFile[]> = new Map()

  /** 设置 git 是否可用 */
  setAvailable(available: boolean): void {
    this.available = available
  }

  /** 设置 mock commits */
  setCommits(commits: GitCommit[]): void {
    this.commits = commits
  }

  /** 设置 mock 文件内容 */
  setFileContent(key: string, content: string): void {
    this.fileContents.set(key, content)
  }

  /** 设置当前分支 */
  setBranch(branch: string): void {
    this.branch = branch
  }

  /** 设置仓库根目录 */
  setRepoRoot(root: string): void {
    this.repoRoot = root
  }

  /** 设置 commit 的文件列表 */
  setCommitFiles(sha: string, files: GitFile[]): void {
    this.commitFiles.set(sha, files)
  }

  /** 重置所有 mock 数据 */
  reset(): void {
    this.available = true
    this.commits = []
    this.fileContents.clear()
    this.branch = 'main'
    this.repoRoot = '/mock/repo'
    this.commitFiles.clear()
  }

  async isAvailable(): Promise<boolean> {
    return this.available
  }

  async getCommits(limit?: number): Promise<GitQueryResult<GitCommit[]>> {
    if (!this.available) {
      return createUnverifiableResult('Git 不可用')
    }

    const commits = limit ? this.commits.slice(0, limit) : this.commits
    return createSuccessResult(commits)
  }

  async getCommit(sha: string): Promise<GitQueryResult<GitCommit>> {
    if (!this.available) {
      return createUnverifiableResult('Git 不可用')
    }

    const commit = this.commits.find((c) => c.sha === sha || c.sha.startsWith(sha))
    if (!commit) {
      return createUnverifiableResult(`未找到 commit: ${sha}`)
    }

    return createSuccessResult(commit)
  }

  async getFileAtCommit(sha: string, filePath: string): Promise<GitQueryResult<string>> {
    if (!this.available) {
      return createUnverifiableResult('Git 不可用')
    }

    const key = `${sha}:${filePath}`
    const content = this.fileContents.get(key)

    if (content === undefined) {
      return createUnverifiableResult(`未找到文件: ${sha}:${filePath}`)
    }

    return createSuccessResult(content)
  }

  async getCurrentFileContent(filePath: string): Promise<GitQueryResult<string>> {
    if (!this.available) {
      return createUnverifiableResult('Git 不可用')
    }

    const key = `HEAD:${filePath}`
    const content = this.fileContents.get(key)

    if (content === undefined) {
      return createUnverifiableResult(`未找到文件: ${filePath}`)
    }

    return createSuccessResult(content)
  }

  async getFilesInCommit(sha: string): Promise<GitQueryResult<GitFile[]>> {
    if (!this.available) {
      return createUnverifiableResult('Git 不可用')
    }

    const files = this.commitFiles.get(sha)
    if (files === undefined) {
      return createUnverifiableResult(`未找到 commit 的文件列表: ${sha}`)
    }

    return createSuccessResult(files)
  }

  async getCurrentBranch(): Promise<GitQueryResult<string>> {
    if (!this.available) {
      return createUnverifiableResult('Git 不可用')
    }

    return createSuccessResult(this.branch)
  }

  async getRepoRoot(): Promise<GitQueryResult<string>> {
    if (!this.available) {
      return createUnverifiableResult('Git 不可用')
    }

    return createSuccessResult(this.repoRoot)
  }
}
