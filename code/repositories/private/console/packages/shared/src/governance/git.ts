/**
 * Git 相关类型定义
 */

/**
 * Git Commit 信息
 */
export interface GitCommit {
  /** Commit SHA */
  readonly sha: string

  /** Commit message */
  readonly message: string

  /** 作者 */
  readonly author: string

  /** 提交时间 */
  readonly date: Date

  /** 变更的文件列表（可选） */
  readonly files?: readonly string[]
}

/**
 * Git 文件变更状态
 */
export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'

/**
 * Git 文件信息
 */
export interface GitFile {
  /** 文件路径 */
  readonly path: string

  /** 变更状态 */
  readonly status: GitFileStatus
}

/**
 * Git 日志查询选项
 */
export interface GitLogOptions {
  /** 最大返回数量 */
  readonly maxCount?: number

  /** 起始 commit */
  readonly from?: string

  /** 结束 commit */
  readonly to?: string

  /** 文件路径过滤 */
  readonly file?: string
}

/**
 * Git 可用性状态
 */
export type GitAvailability =
  | { readonly available: true }
  | {
      readonly available: false
      readonly reason: 'git_unavailable' | 'not_git_repo' | 'git_permission_denied'
    }

/**
 * Git 查询结果
 */
export type GitQueryResult<T> =
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'unverifiable'; readonly reason: string }
