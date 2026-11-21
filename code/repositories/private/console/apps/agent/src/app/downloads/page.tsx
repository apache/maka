'use client';

import dynamic from 'next/dynamic';

// 下载台（2026-10-25 自 linkpull/Go 承接）：spawn yt-dlp 执行下载，引擎不自研。
const DownloadsApp = dynamic(() => import('@/features/downloads/App'), { ssr: false });

export default function DownloadsPage() {
  return <DownloadsApp />;
}
