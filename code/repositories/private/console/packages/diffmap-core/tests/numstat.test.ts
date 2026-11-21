import { describe, expect, it } from 'vitest';
import { parseNumstat } from '../src/numstat.ts';

describe('parseNumstat', () => {
  it('解析普通记录（增 删 路径）', () => {
    const out = '12\t3\tsrc/a.ts\0\0\t5\tdocs/b.md\0';
    expect(parseNumstat(out)).toEqual([
      { additions: 12, deletions: 3, path: 'src/a.ts', oldPath: undefined, binary: false },
      { additions: 0, deletions: 5, path: 'docs/b.md', oldPath: undefined, binary: false },
    ]);
  });

  it('解析 rename（git 2.55 实测：空路径位 + 两条裸路径记录）', () => {
    const out = '2\t1\t\0old/b.ts\0new/c.ts\0';
    expect(parseNumstat(out)).toEqual([
      { additions: 2, deletions: 1, path: 'new/c.ts', oldPath: 'old/b.ts', binary: false },
    ]);
  });

  it('解析纯重命名（0 增 0 删）', () => {
    const out = '0\t0\t\0src/b.ts\0src/c.ts\0';
    expect(parseNumstat(out)).toEqual([
      { additions: 0, deletions: 0, path: 'src/c.ts', oldPath: 'src/b.ts', binary: false },
    ]);
  });

  it('兼容 4 字段 rename 排版', () => {
    const out = '2\t1\told/b.ts\tnew/c.ts\0';
    expect(parseNumstat(out)).toEqual([
      { additions: 2, deletions: 1, path: 'new/c.ts', oldPath: 'old/b.ts', binary: false },
    ]);
  });

  it('二进制文件增删位是 -', () => {
    const out = '-\t-\timg/logo.png\0';
    expect(parseNumstat(out)).toEqual([
      { additions: 0, deletions: 0, path: 'img/logo.png', oldPath: undefined, binary: true },
    ]);
  });

  it('全零变更（纯 mode 修改）也保留条目', () => {
    const out = '0\t0\tsrc/x.ts\0';
    expect(parseNumstat(out)).toEqual([
      { additions: 0, deletions: 0, path: 'src/x.ts', oldPath: undefined, binary: false },
    ]);
  });
});
