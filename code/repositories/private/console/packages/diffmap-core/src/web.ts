// 浏览器侧安全出口：只含类型与纯树布局。走主入口（index.ts）会把 cli/git 的
// node:child_process 拉进客户端 chunk，Turbopack 直接 panic——web 侧一律 import "/web"。
export { buildTree, cellValue, type TreeNode } from "./tree.ts";
export type {
  DiffFile,
  DiffHunk,
  DiffLine,
  DiffMode,
  DiffReport,
  FileChangeKind,
} from "./types.ts";
