import { useCallback, useEffect, useRef, useState } from 'react';
import type { DiffReport } from '@ggbdpq/diffmap-core/web';
import { Treemap } from './components/Treemap';
import { DiffViewer } from './components/DiffViewer';
import { loadStatuses, saveStatuses, type ReviewStatus } from './lib/persist';
import { clampDiffWidth, resolveTheme, type Theme } from './lib/ui';

export default function App() {
  const [report, setReport] = useState<DiffReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ReviewStatus>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // 六期并入适配：主题从 documentElement 改挂本特性根 div（.diffmap-root[data-theme]），与 agent 全局主题互不干扰
  const [theme, setTheme] = useState<Theme>(() =>
    resolveTheme(localStorage.getItem('diffmap:theme'), window.matchMedia('(prefers-color-scheme: dark)').matches),
  );
  const [diffWidth, setDiffWidth] = useState<number | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('diffmap:theme', next);
      return next;
    });
  }, []);

  const onSplitDown = useCallback(
    (e: React.MouseEvent) => {
      const pane = e.currentTarget.nextElementSibling as HTMLElement | null;
      dragRef.current = {
        startX: e.clientX,
        startW: pane ? pane.getBoundingClientRect().width : 600,
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.currentTarget.classList.add('dragging');
      e.preventDefault();
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const total = mainRef.current?.clientWidth ?? window.innerWidth;
      setDiffWidth(clampDiffWidth(dragRef.current.startW + dragRef.current.startX - e.clientX, total));
    };
    const onUp = (e: MouseEvent) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      (e.target as HTMLElement | null)?.classList?.remove('dragging');
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const load = useCallback((refresh: boolean) => {
    // 六期并入适配：repo/mode/base 由 /diffmap 路由查询参数透传给 API（CLI 生成带参 URL）
    const params = new URLSearchParams(window.location.search);
    params.delete('refresh');
    if (refresh) params.set('refresh', '1');
    const qs = params.toString();
    fetch(`/api/diffmap/report${qs ? `?${qs}` : ''}`)
      .then(async (r) => {
        const body = (await r.json()) as DiffReport & { error?: string };
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        return body;
      })
      .then((rep) => {
        setReport(rep);
        setStatuses(loadStatuses(rep));
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // 及时保存审查动作，刷新页面前不留防抖窗口。
  useEffect(() => {
    if (!report) return;
    saveStatuses(report, statuses);
  }, [report, statuses]);

  const selectFile = useCallback((p: string | null) => {
    setSelected(p);
    if (p) setStatuses((prev) => (prev[p] ? prev : { ...prev, [p]: 'seen' }));
  }, []);

  const selectedIndex = report ? report.files.findIndex((f) => f.path === selected) : -1;
  const selectedFile = report && selectedIndex >= 0 ? report.files[selectedIndex] : null;

  const nav = useCallback(
    (delta: number) => {
      if (!report || report.files.length === 0) return;
      const next = Math.min(report.files.length - 1, Math.max(0, selectedIndex + delta));
      selectFile(report.files[next].path);
    },
    [report, selectedIndex, selectFile],
  );

  const setStatus = useCallback((p: string, s: ReviewStatus | null) => {
    setStatuses((prev) => {
      const next = { ...prev };
      if (s === null) delete next[p];
      else next[p] = s;
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === '1' && selectedFile) setStatus(selectedFile.path, 'pass');
      else if (e.key === '2' && selectedFile) setStatus(selectedFile.path, 'question');
      else if (e.key === '3' && selectedFile) setStatus(selectedFile.path, null);
      else if (e.key === 'ArrowLeft') nav(-1);
      else if (e.key === 'ArrowRight') nav(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedFile, nav, setStatus]);

  // 六期并入适配：原版 :root/body 全局样式与变量已作用域化到本根 div
  const shell = (node: React.ReactNode) => (
    <div className="diffmap-root" data-theme={theme} style={{ minHeight: '100dvh' }}>
      {node}
    </div>
  );

  if (error) {
    return shell(
      <div className="fatal">
        diffmap 出错：{error}{' '}
        <button onClick={() => { setError(null); load(true); }}>重试</button>
      </div>,
    );
  }
  if (!report) return shell(<div className="fatal">加载变更集…</div>);

  const files = report.files;
  const seen = files.filter((f) => (statuses[f.path] ?? 'unseen') !== 'unseen').length;
  const passed = files.filter((f) => statuses[f.path] === 'pass').length;
  const questioned = files.filter((f) => statuses[f.path] === 'question').length;

  const onQueryKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && query.trim()) {
      const q = query.trim().toLowerCase();
      const hit = files.find((f) => f.path.toLowerCase().includes(q));
      if (hit) selectFile(hit.path);
    }
  };

  return shell(
    <div className="app">
      <header>
        <h1>Diff Map</h1>
        <span className="repo">{report.repoName}</span>
        <span className="chip">{report.mode === 'base' ? `vs ${report.baseRef}` : '未提交变更'}</span>
        <span className="stat">
          <b className="c-add">+{report.totalAdditions}</b>{' '}
          <b className="c-del">-{report.totalDeletions}</b>{' '}
          <span className="muted">· {files.length} 文件</span>
        </span>
        <span className="cover">
          看过 {seen}/{files.length} · 通过 {passed}/{files.length}
          {questioned > 0 && <b className="c-del"> · 存疑 {questioned}</b>}
        </span>
        <span className="spacer" />
        <input
          type="search"
          placeholder="搜索文件…（回车跳转）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onQueryKey}
        />
        <button onClick={() => load(true)} title="重新读取 git 变更">↻ 刷新</button>
        <button onClick={toggleTheme} title="切换深浅主题">{theme === 'dark' ? '☾' : '☀'}</button>
      </header>
      <main ref={mainRef}>
        {files.length === 0 ? (
          <div className="fatal">没有变更 — 工作区是干净的。</div>
        ) : (
          <>
            <Treemap files={files} statuses={statuses} selected={selected} query={query} onSelect={selectFile} />
            <div className="splitter" onMouseDown={onSplitDown} title="拖动调整两侧宽度" />
            <div
              className="diff-pane"
              style={diffWidth !== null ? { width: diffWidth, flex: '0 0 auto' } : undefined}
            >
              {selectedFile ? (
                <DiffViewer
                  file={selectedFile}
                  index={selectedIndex}
                  total={files.length}
                  repoRoot={report.repoRoot}
                  status={statuses[selectedFile.path] ?? 'unseen'}
                  onStatus={(s) => setStatus(selectedFile.path, s)}
                  onNav={nav}
                />
              ) : (
                <div className="diff-empty pane-hint">
                  ← 点击左侧格子开始审查；打开即记「已读」，1=通过 2=存疑 3=清除，←/→ 切文件
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>,
  );
}
