/** diffmap 数据契约：提取层产出、渲染层消费的唯一 JSON 结构，渲染层不感知 git */

export type DiffMode = 'worktree' | 'base';

export type FileChangeKind = 'added' | 'deleted' | 'renamed' | 'modified';

export interface DiffLine {
  type: 'context' | 'add' | 'del';
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** @@ ... @@ 后面的上下文提示（函数名等） */
  section?: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** 仓库相对路径，'/' 分隔；renamed 时是新路径 */
  path: string;
  /** renamed 时的旧路径 */
  oldPath?: string;
  kind: FileChangeKind;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  /** 文件 diff 与当前内容的指纹，刷新时判定审查标记是否仍有效。 */
  fingerprint?: string;
  /** 仅 added 且来自未跟踪文件：内容从未进过 git */
  untracked?: boolean;
}

export interface DiffReport {
  repoRoot: string;
  repoName: string;
  mode: DiffMode;
  /** base 模式下的参照名（如 main） */
  baseRef?: string;
  /** 持久化 key 的一半：worktree 模式=HEAD，base 模式=merge-base */
  baseSha: string;
  headSha: string;
  generatedAt: string;
  totalAdditions: number;
  totalDeletions: number;
  files: DiffFile[];
}
