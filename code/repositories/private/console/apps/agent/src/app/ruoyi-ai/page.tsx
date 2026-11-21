'use client';

import dynamic from 'next/dynamic';

// ruoyi-ai-web verbatim 并入（2026-10-25）：纯前端 RAG 知识库（IndexedDB + transformers.js 本地向量），
// 无后端能力；dynamic(ssr:false) 规避 IndexedDB/onnxruntime 的 SSR 求值。
const RuoyiAiApp = dynamic(() => import('@/features/ruoyi-ai/App'), { ssr: false });

export default function RuoyiAiPage() {
  return <RuoyiAiApp />;
}
