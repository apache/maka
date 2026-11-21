import { describe, expect, it } from 'vitest';
import { parseDiffSections, attachSections } from '../src/diffparse.ts';
import type { DiffFile } from '../src/types.ts';

const SAMPLE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@ function a',
  ' line1',
  '-old line',
  '+new line',
  ' line3',
  'diff --git a/new.ts b/new.ts',
  'new file mode 100644',
  'index 000..333',
  '--- /dev/null',
  '+++ b/new.ts',
  "@@ -0,0 +1,2 @@",
  '+first',
  '+second',
  '\\ No newline at end of file',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  'index 444..000',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-bye',
  'diff --git a/old/b.ts b/new/c.ts',
  'similarity index 90%',
  'rename from old/b.ts',
  'rename to new/c.ts',
  'index 555..666 100644',
  '--- a/old/b.ts',
  '+++ b/new/c.ts',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  'diff --git a/img.bin b/img.bin',
  'index 777..888 100644',
  'Binary files a/img.bin and b/img.bin differ',
  '',
].join('\n');

describe('parseDiffSections', () => {
  it('按 diff --git 切节并提取路径与标记', () => {
    const secs = parseDiffSections(SAMPLE);
    expect(secs).toHaveLength(5);

    expect(secs[0]).toMatchObject({ oldPath: 'src/a.ts', newPath: 'src/a.ts', isAdded: false, isDeleted: false });
    expect(secs[1]).toMatchObject({ oldPath: null, newPath: 'new.ts', isAdded: true });
    expect(secs[2]).toMatchObject({ oldPath: 'gone.ts', newPath: null, isDeleted: true });
    expect(secs[3]).toMatchObject({ oldPath: 'old/b.ts', newPath: 'new/c.ts' });
    expect(secs[4]!.isBinary).toBe(true);
  });

  it('hunk 正文里以 "--- " 开头的删除行不会被当成节标记', () => {
    const tricky = [
      'diff --git a/x.md b/x.md',
      'index 1..2 100644',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -1,2 +1,2 @@',
      '--- 原来的分隔线',
      '+++ 新的分隔线',
    ].join('\n');
    const [sec] = parseDiffSections(tricky);
    expect(sec).toMatchObject({ oldPath: 'x.md', newPath: 'x.md' });
    expect(sec!.hunkLines).toHaveLength(3);
  });
});

describe('attachSections', () => {
  it('回填 hunks、行号与变更类型', () => {
    const files: DiffFile[] = [
      { path: 'src/a.ts', kind: 'modified', additions: 1, deletions: 1, binary: false, hunks: [] },
      { path: 'new.ts', kind: 'modified', additions: 2, deletions: 0, binary: false, hunks: [] },
      { path: 'gone.ts', kind: 'modified', additions: 0, deletions: 1, binary: false, hunks: [] },
      { path: 'new/c.ts', oldPath: 'old/b.ts', kind: 'renamed', additions: 1, deletions: 1, binary: false, hunks: [] },
      { path: 'img.bin', kind: 'modified', additions: 0, deletions: 0, binary: true, hunks: [] },
    ];
    attachSections(files, parseDiffSections(SAMPLE));

    const [a, added, deleted, renamed, bin] = files as [DiffFile, DiffFile, DiffFile, DiffFile, DiffFile];
    expect(a!.kind).toBe('modified');
    expect(a!.hunks).toHaveLength(1);
    expect(a!.hunks[0]!.section).toBe('function a');
    expect(a!.hunks[0]!.lines).toEqual([
      { type: 'context', oldNo: 1, newNo: 1, text: 'line1' },
      { type: 'del', oldNo: 2, text: 'old line' },
      { type: 'add', newNo: 2, text: 'new line' },
      { type: 'context', oldNo: 3, newNo: 3, text: 'line3' },
    ]);

    expect(added!.kind).toBe('added');
    expect(added!.hunks[0]!.lines.map((l) => l.text)).toEqual(['first', 'second']);

    expect(deleted!.kind).toBe('deleted');

    expect(renamed!.kind).toBe('renamed');
    expect(renamed!.hunks[0]!.lines.map((l) => l.type)).toEqual(['del', 'add']);

    expect(bin!.binary).toBe(true);
    expect(bin!.hunks).toHaveLength(0);
  });
});
