import { describe, expect, it } from 'vitest';
import { buildTree, cellValue } from '../src/tree.ts';
import type { DiffFile } from '../src/types.ts';

function file(path: string, additions: number, deletions: number, binary = false): DiffFile {
  return { path, kind: 'modified', additions, deletions, binary, hunks: [] };
}

describe('buildTree', () => {
  it('按路径嵌套并聚合目录增删数与文件数', () => {
    const root = buildTree([
      file('src/kernel/a.ts', 10, 2),
      file('src/kernel/deep/b.ts', 3, 0),
      file('src/ops/c.ts', 1, 1),
      file('README.md', 5, 0),
    ]);

    expect(root.fileCount).toBe(4);
    const src = root.children!.find((c) => c.name === 'src')!;
    expect(src.isDir).toBe(true);
    expect(src.fileCount).toBe(3);
    expect(src.additions).toBe(14);
    expect(src.deletions).toBe(3);

    const kernel = src.children!.find((c) => c.name === 'kernel')!;
    expect(kernel.children!.map((c) => c.name)).toEqual(['a.ts', 'deep']);

    const readme = root.children!.find((c) => c.name === 'README.md')!;
    expect(readme.isDir).toBe(false);
    expect(readme.file!.path).toBe('README.md');
  });

  it('同名文件与目录不混淆', () => {
    const root = buildTree([file('a', 1, 0), file('a/b.ts', 1, 0)]);
    const kids = root.children!;
    expect(kids.filter((c) => c.name === 'a')).toHaveLength(2);
  });
});

describe('cellValue', () => {
  it('面积 = 变更行数，最小 1；二进制给固定 12', () => {
    expect(cellValue(file('a.ts', 0, 0, false))).toBe(1);
    expect(cellValue(file('a.ts', 7, 3, false))).toBe(10);
    expect(cellValue(file('a.png', 0, 0, true))).toBe(12);
  });
});
