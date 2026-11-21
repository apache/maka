'use client';

import dynamic from "next/dynamic";
import "highlight.js/styles/github.css";
import "@/features/diffmap/index.css";

// diffmap verbatim 并入（六期）：单页 treemap 审查台，dynamic(ssr:false) 取代 Vite createRoot 入口。
// 主题与 :root/body 全局规则已作用域化到 .diffmap-root（data-theme 挂根 div），与 agent 全局主题互不干扰；
// 待审仓库由 URL 查询参数（repo/mode/base）透传给 API，`pnpm cli diffmap [path]` 生成带参入口。
const DiffmapApp = dynamic(() => import("@/features/diffmap/App"), { ssr: false });

export default function DiffmapPage() {
  return <DiffmapApp />;
}
