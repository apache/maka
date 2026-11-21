import type { DiffFile } from './types.ts';

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  additions: number;
  deletions: number;
  /** 目录专用：包含的变更文件数 */
  fileCount: number;
  children?: TreeNode[];
  file?: DiffFile;
}

/** 文件列表 → treemap 用的目录树，目录节点聚合增删数与文件数 */
export function buildTree(files: DiffFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isDir: true, additions: 0, deletions: 0, fileCount: 0, children: [] };
  for (const f of files) {
    const segs = f.path.split('/');
    let node = root;
    node.fileCount++;
    for (let i = 0; i < segs.length; i++) {
      const isLeaf = i === segs.length - 1;
      const name = segs[i]!;
      let child = node.children?.find((c) => c.name === name && c.isDir === !isLeaf);
      if (!child) {
        child = {
          name,
          path: segs.slice(0, i + 1).join('/'),
          isDir: !isLeaf,
          additions: 0,
          deletions: 0,
          fileCount: 0,
          ...(isLeaf ? { file: f } : { children: [] }),
        };
        (node.children ??= []).push(child);
      }
      child.additions += f.additions;
      child.deletions += f.deletions;
      if (!isLeaf) child.fileCount++;
      node = child;
    }
  }
  return root;
}

/** treemap 面积权重：二进制给固定小面积，其余按变更行数（至少 1，保证可见） */
export function cellValue(f: DiffFile): number {
  return f.binary ? 12 : Math.max(1, f.additions + f.deletions);
}
