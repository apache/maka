'use client';

// ruoyi-ai-web verbatim 并入（2026-10-25）：原 Vite + react-router 应用改为 agent 功能台。
// 路由壳用 MemoryRouter（页面与链接零改动），布局沿用自带 app-layout；主题 token 作用域到 .ruoyi-ai-root。
import { useEffect, type ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import AppLayout from '@/features/ruoyi-ai/components/layout/app-layout'
import { useChat } from '@/features/ruoyi-ai/stores/chat'
import { useKnowledge } from '@/features/ruoyi-ai/stores/knowledge'
import Chat from '@/features/ruoyi-ai/pages/chat'
import Chunks from '@/features/ruoyi-ai/pages/chunks'
import Dashboard from '@/features/ruoyi-ai/pages/dashboard'
import KnowledgeDetail from '@/features/ruoyi-ai/pages/knowledge-detail'
import KnowledgeList from '@/features/ruoyi-ai/pages/knowledge-list'
import NotFound from '@/features/ruoyi-ai/pages/not-found'
import './ruoyi-ai.css'

function Boot(props: { children: ReactNode }) {
  const ready = useKnowledge((s) => s.ready)
  const init = useKnowledge((s) => s.init)
  const initChat = useChat((s) => s.init)

  useEffect(() => {
    void init()
    void initChat()
  }, [init, initChat])

  if (!ready) return <div className="grid h-dvh place-items-center text-sm text-muted-foreground">正在加载知识库…</div>
  return props.children
}

export default function App() {
  return (
    <div className="ruoyi-ai-root">
      <MemoryRouter>
        <Boot>
          <Routes>
            <Route element={<AppLayout />}>
              <Route index element={<Dashboard />} />
              <Route path="/knowledge" element={<KnowledgeList />} />
              <Route path="/knowledge/:kbId" element={<KnowledgeDetail />} />
              <Route path="/knowledge/:kbId/chunks/:assetId" element={<Chunks />} />
              <Route path="/chat" element={<Chat />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Boot>
      </MemoryRouter>
    </div>
  )
}
