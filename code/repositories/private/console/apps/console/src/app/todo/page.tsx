'use client';

// 清单台：agent-todo 迁入——页面版 Todo + AI 智能体对话面板。
// 后端已并入本应用 /api/todo/**（Next route handler），写操作经确认卡门禁。

import { useState } from 'react';
import { Sparkle } from '@phosphor-icons/react';
import { cn } from '@ggbdpq/console-ui';
import { TodoPanel } from '@/components/todo/TodoPanel';
import { ChatPanel } from '@/components/todo/ChatPanel';

export default function TodoPage() {
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div
        className={cn(
          'grid grid-cols-1 gap-5 lg:gap-6',
          chatOpen ? 'lg:h-[calc(100dvh-3rem)] lg:grid-cols-[7fr_5fr]' : 'mx-auto max-w-3xl',
        )}
      >
        <main
          className={cn(
            'flex min-h-0 flex-col rounded-xl border border-border bg-card p-6 lg:p-7',
            chatOpen ? '' : 'min-h-[calc(100dvh-3rem)]',
          )}
        >
          <TodoPanel />
        </main>
        {chatOpen && (
          <aside className="fixed inset-0 z-50 bg-background p-4 lg:static lg:z-auto lg:block lg:min-h-0 lg:bg-transparent lg:p-0">
            <ChatPanel onClose={() => setChatOpen(false)} />
          </aside>
        )}
      </div>

      {/* 收起态：右缘常驻竖条按钮，点击展开智能体面板 */}
      {!chatOpen && (
        <button
          onClick={() => setChatOpen(true)}
          className="fixed right-0 top-1/2 z-40 flex -translate-y-1/2 flex-col items-center gap-2.5 rounded-l-xl bg-primary py-4 pl-2.5 pr-3 text-primary-foreground shadow-md transition hover:bg-primary/90 hover:pr-4 active:scale-[0.97]"
          aria-label="展开智能体对话"
        >
          <Sparkle size={17} weight="fill" />
          <span className="text-xs font-medium tracking-widest [writing-mode:vertical-rl]">
            智能体
          </span>
        </button>
      )}
    </div>
  );
}
