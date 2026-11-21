'use client';

// 下载台（linkpull 能力承接）：URL → yt-dlp 下载，任务态轮询。
import { useCallback, useEffect, useState } from 'react';

interface Task {
  id: string;
  url: string;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  log: string[];
  file?: string;
}

const STATE_LABEL: Record<Task['state'], string> = { running: '下载中', done: '完成', failed: '失败' };
const STATE_COLOR: Record<Task['state'], string> = {
  running: 'text-blue-500',
  done: 'text-emerald-600',
  failed: 'text-red-500',
};

export default function App() {
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState('video');
  const [quality, setQuality] = useState('1080');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [downloadDir, setDownloadDir] = useState('');
  const [ytDlp, setYtDlp] = useState('ok');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch('/api/downloads');
    const data = await res.json();
    setTasks(data.tasks ?? []);
    setDownloadDir(data.downloadDir ?? '');
    setYtDlp(data.ytDlp ?? 'missing');
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const submit = useCallback(async () => {
    setError(null);
    const endpoint = mode === 'article' ? '/api/downloads/article' : '/api/downloads';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mode === 'article' ? { url } : { url, quality }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? '提交失败');
      return;
    }
    setUrl('');
    setSelected(data.id);
    void refresh();
  }, [url, quality, mode, refresh]);

  const selectedTask = tasks.find((t) => t.id === selected);

  return (
    <div className="mx-auto max-w-4xl space-4 p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">下载台</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          引擎 yt-dlp（{ytDlp === 'ok' ? '已就绪' : '未安装，brew install yt-dlp ffmpeg'}）· 产物目录{' '}
          <code className="rounded bg-muted px-1">{downloadDir}</code>
        </p>
      </div>

      <div className="flex gap-2">
        <input
          className="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
          placeholder={mode === "article" ? "任意网页 / B站专栏 / X 推文链接" : "B站/YouTube/X 链接"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && url.trim() && void submit()}
        />
        <select
          className="rounded-md border bg-background px-2 py-2 text-sm"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          <option value="video">视频</option>
          <option value="article">文章 MD</option>
        </select>
        <select
          className="rounded-md border bg-background px-2 py-2 text-sm"
          value={quality}
          onChange={(e) => setQuality(e.target.value)}
        >
          <option value="1080">1080P</option>
          <option value="720">720P</option>
          <option value="480">480P</option>
          <option value="audio">仅音频</option>
        </select>
        <button
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={!url.trim() || (mode === 'video' && ytDlp !== 'ok')}
          onClick={() => void submit()}
        >
          下载
        </button>
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="rounded-lg border">
        <div className="border-b px-4 py-2 text-sm font-medium">任务（{tasks.length}）</div>
        {tasks.length === 0 && <p className="px-4 py-6 text-center text-sm text-muted-foreground">还没有任务</p>}
        <ul className="divide-y">
          {tasks.map((t) => (
            <li
              key={t.id}
              className={`cursor-pointer px-4 py-2 text-sm hover:bg-muted/50 ${selected === t.id ? 'bg-muted/50' : ''}`}
              onClick={() => setSelected(t.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{t.url}</span>
                <span className={`shrink-0 font-medium ${STATE_COLOR[t.state]}`}>{STATE_LABEL[t.state]}</span>
              </div>
              <div className="text-xs text-muted-foreground">{t.startedAt.replace('T', ' ').slice(0, 19)} · {t.id}</div>
            </li>
          ))}
        </ul>
      </div>

      {selectedTask && (
        <div className="rounded-lg border">
          <div className="border-b px-4 py-2 text-sm font-medium">日志 · {selectedTask.id}</div>
          <pre className="max-h-72 overflow-auto px-4 py-2 text-xs leading-5">{selectedTask.log.join('\n') || '（等待输出）'}</pre>
        </div>
      )}
    </div>
  );
}
