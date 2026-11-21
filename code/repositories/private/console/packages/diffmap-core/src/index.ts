// diffmap-core：git 变更 treemap 审查引擎（六期自 diffmap 并入）。
// 提取层（git→DiffReport）与树布局在此，web 渲染在 apps/agent features/diffmap。
export {
  extractReport,
  type ExtractOptions,
} from "./extract.ts";
export {
  findRepoRoot,
  mergeBase,
  resolveRef,
} from "./git.ts";
export {
  buildTree,
  cellValue,
  type TreeNode,
} from "./tree.ts";
export type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffMode,
  DiffReport,
  FileChangeKind,
} from "./types.ts";
export {
  buildDiffmapUrl,
  createDiffmapCommand,
  DEFAULT_AGENT_BASE,
  DiffmapCliError,
  parseDiffmapArgs,
  type DiffmapCliArgs,
} from "./cli.ts";
