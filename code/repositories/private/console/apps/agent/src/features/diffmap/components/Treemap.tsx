import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { hierarchy, treemap, type HierarchyRectangularNode } from 'd3-hierarchy';
import { buildTree, cellValue, type TreeNode } from '@ggbdpq/diffmap-core/web';
import type { DiffFile } from '@ggbdpq/diffmap-core/web';
import type { ReviewStatus } from '../lib/persist';
import { tooltipStyle } from '../lib/ui';
import { KIND_LABEL } from './DiffViewer';

interface Props {
  files: DiffFile[];
  statuses: Record<string, ReviewStatus>;
  selected: string | null;
  query: string;
  onSelect(path: string): void;
}

const DIR_HEADER = 18;

const STATUS_LABEL: Record<ReviewStatus, string> = {
  unseen: '未读',
  seen: '已读',
  pass: '通过',
  question: '存疑',
};

export function Treemap({ files, statuses, selected, query, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const logged = useRef(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<DiffFile | null>(null);
  const hoverRef = useRef<DiffFile | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const lastCursor = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const nodes = useMemo(() => {
    if (size.w < 60 || size.h < 60 || files.length === 0) return [];
    const root = hierarchy<TreeNode>(buildTree(files))
      .sum((n) => (n.isDir ? 0 : cellValue(n.file!)))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    // d3 的类型把布局返回值标成 HierarchyNode，但运行时带 x0/y0/x1/y1
    const laidOut = treemap<TreeNode>()
      .size([size.w, size.h])
      .paddingInner(3)
      .paddingOuter(2)
      .paddingTop((n) => (n.children && n.depth > 0 ? DIR_HEADER : 0))(root) as unknown as HierarchyRectangularNode<TreeNode>;
    return laidOut.descendants().filter((n) => n.depth > 0);
  }, [files, size.w, size.h]);

  // 首帧性能日志（验收指标：打开到可交互 < 3s）
  useEffect(() => {
    const t0 = (window as unknown as Record<string, number | undefined>).__diffmapT0;
    if (!logged.current && nodes.length > 0 && typeof t0 === 'number') {
      logged.current = true;
      console.info(`[diffmap] treemap 首帧：${nodes.length} 个矩形，自启动 ${(performance.now() - t0).toFixed(0)}ms`);
    }
  }, [nodes]);

  // 换文件时按光标位置定位一次；同格子内移动由容器的 mousemove 免重渲染跟手
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!hover || !tip) return;
    const s = tooltipStyle(lastCursor.current.x, lastCursor.current.y, tip.offsetWidth, tip.offsetHeight, window.innerWidth, window.innerHeight);
    tip.style.left = `${s.left}px`;
    tip.style.top = `${s.top}px`;
  }, [hover]);

  const onContainerMove = (e: React.MouseEvent) => {
    lastCursor.current = { x: e.clientX, y: e.clientY };
    const tip = tipRef.current;
    if (!hoverRef.current || !tip) return;
    const s = tooltipStyle(e.clientX, e.clientY, tip.offsetWidth, tip.offsetHeight, window.innerWidth, window.innerHeight);
    tip.style.left = `${s.left}px`;
    tip.style.top = `${s.top}px`;
  };

  const setCellHover = (f: DiffFile | null) => {
    hoverRef.current = f;
    setHover(f);
  };

  const q = query.trim().toLowerCase();

  return (
    <div ref={ref} className="tm" onMouseMove={onContainerMove}>
      {nodes.map((n) =>
        n.children ? (
          <div
            key={n.data.path}
            className="tm-dir"
            title={`${n.data.path}/ · ${n.data.fileCount} 个文件 · +${n.data.additions}/-${n.data.deletions}`}
            style={{ left: n.x0, top: n.y0, width: n.x1 - n.x0, height: n.y1 - n.y0 }}
          >
            <span className="tm-dir-label">{n.data.name}</span>
          </div>
        ) : (
          <FileCell
            key={n.data.path}
            node={n}
            status={statuses[n.data.path] ?? 'unseen'}
            selected={selected === n.data.path}
            dim={q !== '' && !n.data.path.toLowerCase().includes(q)}
            onSelect={onSelect}
            onHover={setCellHover}
          />
        ),
      )}
      {hover && (
        <div className="tooltip" ref={tipRef}>
          <div className="tt-path">
            {hover.oldPath ? `${hover.oldPath} → ${hover.path}` : hover.path}
          </div>
          <div className="tt-row">
            <span className="c-add">+{hover.additions}</span>
            <span className="c-del">-{hover.deletions}</span>
            <span>{KIND_LABEL[hover.kind]}{hover.untracked ? ' · 未跟踪' : ''}</span>
            {hover.binary && <span>二进制</span>}
            <span>状态：{STATUS_LABEL[statuses[hover.path] ?? 'unseen']}</span>
          </div>
        </div>
      )}
    </div>
  );
}

interface CellProps {
  node: HierarchyRectangularNode<TreeNode>;
  status: ReviewStatus;
  selected: boolean;
  dim: boolean;
  onSelect(path: string): void;
  onHover(f: DiffFile | null): void;
}

function FileCell({ node, status, selected, dim, onSelect, onHover }: CellProps) {
  const f = node.data.file!;
  const w = node.x1 - node.x0;
  const h = node.y1 - node.y0;
  const total = f.additions + f.deletions;
  const addPct = total > 0 ? (f.additions / total) * 100 : 0;
  const showName = w > 46 && h > 28;
  const showMeta = w > 46 && h > 46;

  return (
    <div
      className={`tm-cell st-${status}${selected ? ' sel' : ''}${dim ? ' dim' : ''}`}
      style={{ left: node.x0, top: node.y0, width: w, height: h }}
      onClick={() => onSelect(f.path)}
      onMouseEnter={() => onHover(f)}
      onMouseLeave={() => onHover(null)}
    >
      {showName && <span className="cell-name">{f.path.split('/').pop()}</span>}
      {showMeta && (
        <span className="cell-counts">
          {f.binary ? 'binary' : `+${f.additions}${f.deletions > 0 ? ` -${f.deletions}` : ''}`}
        </span>
      )}
      {total > 0 && (
        <span className="cell-bar" style={{ width: Math.max(0, w - 12) }}>
          <i className="b-add" style={{ width: `${addPct}%` }} />
          <i className="b-del" style={{ width: `${100 - addPct}%` }} />
        </span>
      )}
    </div>
  );
}
