/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { makaTheme } from '../renderer/astryx-theme/maka.js';
import { LocaleProvider } from '../../../../packages/ui/src/locale-context.js';
import { Markdown } from '../../../../packages/ui/src/markdown.js';
import { MessageSummary } from '../../../../packages/ui/src/message-summary.js';
import type { WebAvatar, WebHistory, WebMessage, WebState } from '../shared/assistant-web.js';
import './style.css';

type Pending = { id: string; text: string; conversationId: string; failed?: boolean };
const OUTBOX = 'maka-assistant-web-outbox-v1';
function restore(): Pending[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(OUTBOX) ?? '[]');
    return Array.isArray(value)
      ? value
          .filter(
            (v): v is Pending =>
              v &&
              typeof v.id === 'string' &&
              typeof v.text === 'string' &&
              typeof v.conversationId === 'string',
          )
          .map((v) => ({ ...v, failed: true }))
      : [];
  } catch {
    return [];
  }
}
// randomUUID is unavailable on plain HTTP LAN origins; getRandomValues is supported there.
function messageId() {
  return (
    'web-' +
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
      v.toString(16).padStart(2, '0'),
    ).join('')
  );
}
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new ApiError(response.status, body.error ?? '连接失败，请稍后重试');
  return body as T;
}
function AssistantAvatar({ avatar, header = false }: { avatar?: WebAvatar; header?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const image = avatar?.imageUrl && avatar.imageUrl !== failedUrl ? avatar.imageUrl : undefined;
  return (
    <div
      className={`avatar assistant-avatar${header ? ' header-avatar' : ''}`}
      style={{ backgroundColor: avatar?.background ?? '#E5EDFF' }}
      role="img"
      aria-label="个人助手头像"
    >
      {image ? (
        <img src={image} alt="" draggable={false} onError={() => setFailedUrl(image)} />
      ) : (
        (avatar?.emoji ?? '🤖')
      )}
    </div>
  );
}
function UserAvatar() {
  return (
    <div className="avatar user-avatar" aria-label="我">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <circle cx="12" cy="8" r="3.2" />
        <path d="M5.5 20v-2a6.5 6.5 0 0 1 13 0v2" />
      </svg>
    </div>
  );
}
function messageTime(at: number) {
  const date = new Date(at);
  const today = date.toDateString() === new Date().toDateString();
  return `${today ? '今天 ' : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' '}${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}
function App() {
  const [messages, setMessages] = useState<WebMessage[]>([]);
  const [pending, setPending] = useState<Pending[]>(restore);
  const [state, setState] = useState<WebState>();
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [older, setOlder] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const current = useRef<{ id: string; through: number | null } | undefined>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lane = useRef<Promise<unknown>>(Promise.resolve());
  const alive = useRef(true);
  const inFlight = useRef(new Set<string>());
  const serial = (fn: () => Promise<void>) => {
    lane.current = lane.current.then(fn, fn).catch((e: Error) => {
      if (!alive.current) return;
      setError(e.message);
      if (!retryTimer.current)
        retryTimer.current = setTimeout(() => {
          retryTimer.current = undefined;
          if (alive.current) serial(() => sync());
        }, 2000);
    });
  };
  function merge(page: WebHistory, reset = false) {
    if (!alive.current) return;
    setMessages((old) =>
      [...new Map([...(reset ? [] : old), ...page.messages].map((m) => [m.id, m])).values()].sort(
        (a, b) => a.sequence - b.sequence,
      ),
    );
    const ids = new Set(page.messages.map((m) => m.id));
    setPending((old) => old.filter((p) => !ids.has(p.id)));
  }
  async function sync(expectedId?: string, retry = true): Promise<void> {
    try {
      const before = current.current;
      const reset =
        !before || before.through === null || (!!expectedId && expectedId !== before.id);
      const query =
        !reset && before.through !== null
          ? `?conversationId=${encodeURIComponent(before.id)}&after=${before.through}`
          : '';
      let page = await api<WebHistory>(`/api/history${query}`);
      if (!alive.current) return;
      merge(page, reset);
      if (reset) setOlder(page.next);
      else {
        while (page.next) {
          page = await api<WebHistory>(`/api/history?cursor=${encodeURIComponent(page.next)}`);
          merge(page);
        }
      }
      current.current = { id: page.conversationId, through: page.through };
      setError('');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && retry) {
        current.current = undefined;
        await sync(undefined, false);
      } else throw error;
    }
  }
  useEffect(() => {
    alive.current = true;
    const events = new EventSource('/api/events');
    events.onopen = () => {
      setConnected(true);
      serial(() => sync());
    };
    events.onerror = () => {
      setConnected(false);
    };
    events.onmessage = (event) => {
      const value = JSON.parse(event.data) as { state?: WebState; error?: string };
      if (value.error) {
        setError(value.error);
        setState(undefined);
        return;
      }
      const next = value.state!;
      setState(next);
      serial(async () => {
        if (
          current.current?.id !== next.conversationId ||
          current.current?.through !== next.revision
        )
          await sync(next.conversationId);
      });
    };
    const refresh = () => {
      if (document.visibilityState === 'visible') serial(() => sync());
    };
    document.addEventListener('visibilitychange', refresh);
    return () => {
      alive.current = false;
      clearTimeout(retryTimer.current);
      events.close();
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      if (!viewport || viewport.scale === 1)
        document.documentElement.style.setProperty(
          '--app-height',
          `${viewport?.height ?? innerHeight}px`,
        );
    };
    resize();
    viewport?.addEventListener('resize', resize);
    return () => viewport?.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(OUTBOX, JSON.stringify(pending));
    } catch {
      /* sending remains possible without browser storage */
    }
  }, [pending]);
  useEffect(() => {
    if (nearBottom.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages, pending, state?.working]);
  async function send(item: Pending) {
    if (inFlight.current.has(item.id)) return;
    inFlight.current.add(item.id);
    setPending((old) => old.map((p) => (p.id === item.id ? { ...p, failed: false } : p)));
    try {
      await api('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item),
      });
      serial(() => sync());
    } catch (e) {
      setPending((old) => old.map((p) => (p.id === item.id ? { ...p, failed: true } : p)));
      setError((e as Error).message);
    } finally {
      inFlight.current.delete(item.id);
    }
  }
  function submit() {
    if (!text.trim() || !state || !connected) return;
    const item = { id: messageId(), text: text.trim(), conversationId: state.conversationId };
    setPending((old) => [...old, item]);
    setText('');
    nearBottom.current = true;
    void send(item);
  }
  function loadOlder() {
    if (!older || loading) return;
    setLoading(true);
    serial(async () => {
      const element = scroller.current;
      const height = element?.scrollHeight ?? 0;
      try {
        const page = await api<WebHistory>(`/api/history?cursor=${encodeURIComponent(older)}`);
        nearBottom.current = false;
        merge(page);
        setOlder(page.next);
        requestAnimationFrame(() => {
          if (element) element.scrollTop += element.scrollHeight - height;
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          current.current = undefined;
          await sync();
        } else throw error;
      } finally {
        setLoading(false);
      }
    });
  }
  const rows = pending.filter(
    (p) => p.conversationId === state?.conversationId && !messages.some((m) => m.id === p.id),
  );
  return (
    <div className="web-shell">
      <header>
        <AssistantAvatar avatar={state?.avatar} header />
        <div>
          <h1>个人助手</h1>
          <p>
            <i data-online={connected && !!state} />
            {!connected
              ? '正在连接…'
              : !state
                ? '等待桌面端就绪'
                : state.working
                  ? '正在处理'
                  : '与桌面同步'}
          </p>
        </div>
        <span className="brand">Maka</span>
      </header>
      {error && (
        <div className="notice" role="alert">
          {error}
          <button
            onClick={() => {
              current.current = undefined;
              serial(() => sync(state?.conversationId));
            }}
          >
            重新连接
          </button>
        </div>
      )}
      <main
        ref={scroller}
        onScroll={() => {
          const el = scroller.current!;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
        }}
        aria-label="聊天记录"
      >
        {older && (
          <button className="history" onClick={loadOlder} disabled={loading}>
            {loading ? '加载中…' : '查看更早的消息'}
          </button>
        )}
        {!messages.length && !rows.length && (
          <div className="empty">
            <AssistantAvatar avatar={state?.avatar} header />
            <h2>从这里，继续聊。</h2>
            <p>
              和电脑上的同一个助手，
              <br />
              消息与进展都会同步到这里。
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id}>
            {(i === 0 || m.at - messages[i - 1]!.at > 5 * 60 * 1000) && (
              <div className="time">{messageTime(m.at)}</div>
            )}
            <article
              className={`message ${m.role}`}
              data-grouped={
                i > 0 && messages[i - 1]!.role === m.role && m.at - messages[i - 1]!.at < 120000
              }
            >
              {m.role === 'assistant' ? <AssistantAvatar avatar={state?.avatar} /> : <UserAvatar />}
              <div className="bubble">
                <MessageSummary summary={m.summary}>
                  <Markdown text={m.text} density="compact" imageDisplay="link" />
                </MessageSummary>
              </div>
            </article>
          </div>
        ))}
        {rows.map((p) => (
          <article className="message user" key={p.id}>
            <UserAvatar />
            <div>
              <div className="bubble pending">{p.text}</div>
              <div className="delivery">
                {p.failed ? (
                  <button onClick={() => void send(p)}>未确认送达 · 点击重试</button>
                ) : (
                  '正在发送…'
                )}
              </div>
            </div>
          </article>
        ))}
        {state?.working && (
          <article className="message assistant" role="status" aria-label="正在输入">
            <AssistantAvatar avatar={state?.avatar} />
            <div className="bubble typing">
              <span />
              <span />
              <span />
            </div>
          </article>
        )}
      </main>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="composer">
          <textarea
            rows={1}
            value={text}
            maxLength={32000}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            placeholder="和助手说点什么…"
            aria-label="消息"
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                matchMedia('(pointer: fine)').matches
              ) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="submit"
            disabled={!text.trim() || !connected || !state}
            aria-label="发送消息"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 11 6-6 6 6M12 5v14" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <Theme theme={makaTheme} mode="light">
    <LocaleProvider locale="zh-CN">
      <App />
    </LocaleProvider>
  </Theme>,
);
