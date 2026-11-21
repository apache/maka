import type { DiffFile, DiffHunk } from './types.ts';

export interface DiffSection {
  oldPath: string | null;
  newPath: string | null;
  isAdded: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  /** 从第一个 @@ 起的原始行（含 @@ 头） */
  hunkLines: string[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function markerPath(raw: string): string | null {
  let p = raw.trimEnd();
  if (p.startsWith('"')) {
    try {
      p = JSON.parse(p) as string;
    } catch {
      /* 引号解不开就按原样处理 */
    }
  }
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** 把整段 git diff 文本切成每文件的节 */
export function parseDiffSections(text: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let cur: DiffSection | null = null;
  let inHunks = false;

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur) sections.push(cur);
      cur = { oldPath: null, newPath: null, isAdded: false, isDeleted: false, isBinary: false, hunkLines: [] };
      inHunks = false;
      continue;
    }
    if (!cur) continue;

    if (inHunks) {
      // hunk 区域内一切行都归内容（正文里可能出现 "--- foo" 之类的删除行）
      cur.hunkLines.push(line);
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      cur.newPath = line.slice('rename to '.length);
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      cur.isBinary = true;
    } else if (line.startsWith('--- ')) {
      cur.oldPath = markerPath(line.slice(4));
      if (cur.oldPath === null) cur.isAdded = true;
    } else if (line.startsWith('+++ ')) {
      cur.newPath = markerPath(line.slice(4));
      if (cur.newPath === null) cur.isDeleted = true;
      inHunks = true;
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

function buildHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newLines: m[4] ? Number(m[4]) : 1,
        section: m[5]!.trim() || undefined,
        lines: [],
      };
      hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    if (!hunk) continue;
    const tag = line[0];
    const text = line.slice(1);
    if (tag === '\\') continue; // "\ No newline at end of file"：无行号含义
    if (tag === ' ') hunk.lines.push({ type: 'context', oldNo: oldNo++, newNo: newNo++, text });
    else if (tag === '+') hunk.lines.push({ type: 'add', newNo: newNo++, text });
    else if (tag === '-') hunk.lines.push({ type: 'del', oldNo: oldNo++, text });
  }
  return hunks;
}

function findFile(files: DiffFile[], sec: DiffSection): DiffFile | undefined {
  return files.find(
    (f) =>
      (sec.newPath !== null && f.path === sec.newPath) ||
      (sec.oldPath !== null && (f.oldPath === sec.oldPath || f.path === sec.oldPath)),
  );
}

/** 把节的 hunks 与增删标记回填到文件条目上 */
export function attachSections(files: DiffFile[], sections: DiffSection[]): void {
  for (const sec of sections) {
    const f = findFile(files, sec);
    if (!f) continue;
    f.hunks = buildHunks(sec.hunkLines);
    if (sec.isAdded) f.kind = 'added';
    else if (sec.isDeleted) f.kind = 'deleted';
    else if (f.oldPath || (sec.oldPath && sec.newPath && sec.oldPath !== sec.newPath)) f.kind = 'renamed';
    if (sec.isBinary) f.binary = true;
  }
}
