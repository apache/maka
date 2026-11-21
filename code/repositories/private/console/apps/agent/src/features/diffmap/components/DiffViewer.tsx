import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile, DiffLine, FileChangeKind } from '@ggbdpq/diffmap-core/web';
import type { ReviewStatus } from '../lib/persist';
import { langOf, highlightLine } from '../lib/highlight';

export const KIND_LABEL: Record<FileChangeKind, string> = {
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
  modified: '修改',
};

/** 单文件 diff 超过这个行数先只渲染一部分，点击再展开（防巨文件卡死） */
const RENDER_CHUNK = 4000;

interface Props {
  file: DiffFile;
  index: number;
  total: number;
  repoRoot: string;
  status: ReviewStatus;
  onStatus(status: ReviewStatus | null): void;
  onNav(delta: number): void;
}

type Row = { kind: 'hunk'; label: string } | { kind: 'line'; line: DiffLine };

export function DiffViewer({ file, index, total, repoRoot, status, onStatus, onNav }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
    bodyRef.current?.scrollTo(0, 0);
  }, [file.path]);

  const lang = useMemo(() => langOf(file.path), [file.path]);
  const absPath = `${repoRoot.replaceAll('\\', '/')}/${file.path}`;

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const h of file.hunks) {
      out.push({
        kind: 'hunk',
        label: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ` ${h.section}` : ''}`,
      });
      for (const l of h.lines) out.push({ kind: 'line', line: l });
    }
    return out;
  }, [file]);

  const visible = expanded || rows.length <= RENDER_CHUNK ? rows : rows.slice(0, RENDER_CHUNK);

  return (
    <>
      <div className="diff-head">
        <button className="nav" disabled={index <= 0} onClick={() => onNav(-1)} title="上一个（←）">‹</button>
        <span className="nav-pos">{index + 1}/{total}</span>
        <button className="nav" disabled={index >= total - 1} onClick={() => onNav(1)} title="下一个（→）">›</button>
        <span className="diff-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <span className={`kind kind-${file.kind}`}>
          {KIND_LABEL[file.kind]}
          {file.untracked ? ' · 未跟踪' : ''}
        </span>
        <span className="spacer" />
        <button className={`st-btn${status === 'pass' ? ' on-pass' : ''}`} onClick={() => onStatus(status === 'pass' ? null : 'pass')}>
          通过 <kbd>1</kbd>
        </button>
        <button className={`st-btn${status === 'question' ? ' on-question' : ''}`} onClick={() => onStatus(status === 'question' ? null : 'question')}>
          存疑 <kbd>2</kbd>
        </button>
        {status !== 'unseen' && (
          <button className="st-btn" onClick={() => onStatus(null)}>
            清除 <kbd>3</kbd>
          </button>
        )}
        {file.kind !== 'deleted' && !file.binary && (
          <>
            <a className="open-link" href={`zed://file/${absPath}`} title="在 Zed 打开">Zed</a>
            <a className="open-link" href={`vscode://file/${absPath}`} title="在 VS Code 打开">VS Code</a>
          </>
        )}
      </div>
      <div className="diff-body" ref={bodyRef}>
        {file.binary ? (
          <div className="diff-empty">二进制文件，请在编辑器里查看。</div>
        ) : file.hunks.length === 0 ? (
          <div className="diff-empty">
            {file.kind === 'renamed' ? '纯重命名，内容无变化。' : '无内容变化（可能只有权限或元数据变更）。'}
          </div>
        ) : (
          <>
            {visible.map((row, i) =>
              row.kind === 'hunk' ? (
                <div key={i} className="hunk-head">{row.label}</div>
              ) : (
                <div key={i} className={`dl ${row.line.type}`}>
                  <span className="no">{row.line.oldNo ?? ''}</span>
                  <span className="no">{row.line.newNo ?? ''}</span>
                  <span className="code" dangerouslySetInnerHTML={{ __html: highlightLine(row.line.text, lang) }} />
                </div>
              ),
            )}
            {!expanded && rows.length > RENDER_CHUNK && (
              <button className="more" onClick={() => setExpanded(true)}>
                该文件 diff 共 {rows.length} 行，已渲染前 {RENDER_CHUNK} 行 — 点击渲染剩余
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
