'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageCircle, Send, Sparkle, Square } from 'lucide-react';
import { streamPracticeChat } from '@/lib/practice/chat';
import { Button } from '@ggbdpq/console-ui';
import { cn } from '@ggbdpq/console-ui';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@ggbdpq/console-ui';
import { Markdown } from '@ggbdpq/console-ui';

interface ChatItem {
  role: 'user' | 'assistant';
  text: string;
  status?: 'partial' | 'error';
}

const QUICK_PROMPTS = [
  '分析我反复犯的错误，列出证据',
  '我的时间投入分布和节奏怎么样',
  '给我 3 条最该改的工程习惯',
];

/** 右下角浮动复盘对话：DeepSeek 流式解读本地统计数据（无工具回路） */
export function ChatDock({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    setItems((prev) => [...prev, { role: 'user', text: message }, { role: 'assistant', text: '', status: 'partial' }]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      for await (const event of streamPracticeChat({ message }, controller.signal)) {
        if (event.type === 'delta') {
          setItems((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant') last.text += event.text;
            return next;
          });
        } else if (event.type === 'error') {
          setItems((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant') {
              last.status = 'error';
              if (!last.text) last.text = `出错了：${event.message}`;
            }
            return next;
          });
          break;
        } else if (event.type === 'done') {
          break;
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setItems((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') last.text += `\n\n[连接中断：${(err as Error).message}]`;
          return next;
        });
      }
    } finally {
      setItems((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && last.status === 'partial') last.status = undefined;
        return next;
      });
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="复盘对话"
        className="fixed bottom-6 right-6 z-40 grid size-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition hover:bg-primary/90 active:scale-95"
      >
        <MessageCircle className="size-5" />
      </button>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent className="flex w-[460px] max-w-[94vw] flex-col">
          <DrawerHeader>
            <DrawerTitle className="flex items-center gap-2">
              <Sparkle className="size-4 text-primary" />
              实践复盘助手
            </DrawerTitle>
            <p className="text-xs text-muted-foreground">
              基于本地同步的提交统计做模式分析；commit 数据会发送给 DeepSeek API。
            </p>
          </DrawerHeader>

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3">
            {items.length === 0 && (
              <div className="space-y-2 pt-6">
                <p className="text-sm text-muted-foreground">想从哪里开始？</p>
                {QUICK_PROMPTS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={disabled}
                    onClick={() => void send(p)}
                    className="block w-full rounded-lg border bg-card px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground disabled:opacity-50"
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}

            {items.map((item, i) =>
              item.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-xl rounded-br-md bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
                    {item.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex justify-start gap-2">
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                    <Sparkle className="size-3.5" />
                  </span>
                  <div
                    className={cn(
                      'max-w-[88%] rounded-xl rounded-bl-md border bg-card px-3.5 py-2 shadow-sm',
                      item.status === 'error' && 'border-destructive/40',
                    )}
                  >
                    {item.text ? (
                      <Markdown content={item.text} className="text-[13px] leading-6" />
                    ) : (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    )}
                  </div>
                </div>
              ),
            )}
          </div>

          <form
            className="flex items-end gap-2 border-t pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={2}
              placeholder="问问你的提交历史…（Enter 发送，Shift+Enter 换行）"
              disabled={busy || disabled}
              className="max-h-32 flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring disabled:opacity-50"
            />
            {busy ? (
              <Button type="button" variant="outline" size="icon" onClick={stop} title="停止生成">
                <Square className="size-4" />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!input.trim() || disabled} title="发送">
                <Send className="size-4" />
              </Button>
            )}
          </form>
        </DrawerContent>
      </Drawer>
    </>
  );
}
