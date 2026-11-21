'use client';

import dynamic from "next/dynamic";
import { useEffect } from "react";
import "@/features/deck/styles.css";

// 幻灯片引擎 verbatim：.deck 是 position:fixed 全屏舞台（1600×900 等比缩放），
// 进入本路由即整屏接管，浏览器返回键退出；hash 翻页与键盘/触摸引擎零改动。
const DeckApp = dynamic(() => import("@/features/deck/App"), { ssr: false });

// 原版入口行为迁移：URL 带 ?static 时给文档根加 .static 类（打印/导出停用动画）
export default function DeckPage() {
  useEffect(() => {
    if (/[?&]static/.test(window.location.search)) {
      document.documentElement.classList.add("static");
      return () => document.documentElement.classList.remove("static");
    }
  }, []);
  return <DeckApp />;
}
