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

import { createAssistantNavigation, identity } from './navigation.js';
import { useEffect, useState } from 'react';
import { SideNavItem } from '@astryxdesign/core/SideNav';
import { Sparkles } from '@maka/ui/icons';
import type { DesktopRuntimeHostRef } from '../../../preload/bridge-contract.js';
import type { PersonalAssistantRequest } from '@maka/runtime-host/protocol';

export async function assistantCall(
  method: PersonalAssistantRequest['method'],
  input: unknown = {},
  host?: DesktopRuntimeHostRef,
): Promise<any> {
  const result = await window.maka.runtimeHost.command(
    'personal-assistant.call',
    { method, input },
    host,
  );
  return result.value;
}
const navigation = createAssistantNavigation({
  host: () => window.maka.runtimeHostProfiles.getDefaultHost(),
  binding: (host) => assistantCall('assistant.binding', {}, host),
  bind: (host, sessionId) => assistantCall('assistant.bind', { sessionId }, host),
  create: () => window.maka.sessions.create({ name: '个人助手', labels: ['personal-assistant'] }),
  list: () => window.maka.sessions.list(),
});
export const openAssistant = () => navigation.open();

export function PersonalAssistantEntry({
  activeSessionId,
  openSession,
}: {
  activeSessionId?: string;
  openSession(id: string): void;
}) {
  const [bound, setBound] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const host = await window.maka.runtimeHostProfiles.getDefaultHost();
        const { state } = await assistantCall('assistant.binding', {}, host);
        if (live) {
          setBound(state && host ? JSON.stringify([host.hostId, state.sessionId]) : undefined);
          setError('');
        }
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        if (live) timer = setTimeout(check, 10000);
      }
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  return (
    <SideNavItem
      label="个人助手"
      icon={Sparkles}
      size="md"
      isSelected={!!bound && bound === activeSessionId}
      aria-label={error ? '个人助手：' + error : '个人助手'}
      endContent={error ? <span aria-label={error}>!</span> : undefined}
      onClick={() => {
        void openAssistant()
          .then((id) => {
            setBound(id);
            setError('');
            openSession(id);
          })
          .catch((e) => setError(String(e)));
      }}
    />
  );
}

const time = (at?: number | null) => (at ? new Date(at).toLocaleString() : '—');
export function PersonalAssistantSettings({
  host,
  onOpenSession,
}: {
  host?: DesktopRuntimeHostRef;
  onOpenSession?(id: string): void;
}) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState(30);
  const refresh = async () => {
    const value = await assistantCall('assistant.status', {}, host);
    setData(value);
    return value;
  };
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await assistantCall('assistant.status', {}, host);
        if (live) setData(value);
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        if (live) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [host?.hostId, host?.profileId]);
  const act = async (method: PersonalAssistantRequest['method'], input: unknown) => {
    setBusy(true);
    setError('');
    try {
      await assistantCall(method, input, host);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const recover = (input: unknown) => {
    void act('assistant.recover', input);
  };
  const control = (action: string) => {
    void act('assistant.control', {
      action,
      ...(action === 'enable' ? { intervalMinutes: minutes } : {}),
    });
  };
  if (!data)
    return <div className="personal-assistant-settings">{error || '正在读取个人助手状态…'}</div>;
  const openTask = async (sessionId: string) => {
    try {
      const matches = (await window.maka.sessions.list()).filter(
        (s) =>
          identity(s.id)[1] === sessionId &&
          (!identity(s.id)[0] || identity(s.id)[0] === host?.hostId),
      );
      if (matches.length !== 1) throw Error('无法定位任务会话，请确认 Host 在线。');
      onOpenSession?.(matches[0]!.id);
    } catch (e) {
      setError(String(e));
    }
  };
  const state = data.state;
  return (
    <div className="personal-assistant-settings">
      <h2>个人助手</h2>
      <p>
        通过侧栏的个人助手入口聊天。记忆索引和持续任务已内置；导入历史和启用主动发现均由你决定。
      </p>
      {error && <p role="alert">{error}</p>}
      {!state ? (
        <p>请先从侧栏打开个人助手，创建专属会话。</p>
      ) : (
        <>
          <section>
            <h3>主动发现</h3>
            <p>
              {state.enabled ? '已启用' : '已暂停'} · 上次检查 {time(state.lastCheckedAt)} ·
              下次检查 {time(state.nextAt)}
            </p>
            {state.lastError && <p role="alert">{state.lastError}</p>}
            <p>{data.readiness?.notice}</p>
            {data.readiness?.sessionError && <p role="alert">{data.readiness.sessionError}</p>}
            <label>
              检查间隔（分钟）{' '}
              <input
                type="number"
                min={1}
                max={10080}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />
            </label>
            <div className="pa-controls">
              <button disabled={busy} onClick={() => control('enable')}>
                启用并立即检查
              </button>
              <button disabled={busy || !state.enabled} onClick={() => control('pause')}>
                暂停
              </button>
              <button disabled={busy} onClick={() => control('check')}>
                检查一次
              </button>
            </div>
          </section>
          <section>
            <h3>记忆索引</h3>
            <p>不会自动导入或建索引。可以在聊天里说明需要整理的来源与要求。</p>
            {data.memory?.error && <p role="alert">{data.memory.error}</p>}
            {(data.memory?.indexes ?? []).map((item: any) => (
              <article key={item.id}>
                <strong>{item.name || item.id}</strong>
                <p>
                  {item.unavailable
                    ? '来源暂不可用'
                    : `待整理变化：${item.freshness?.knownPending ?? '未知'}`}
                </p>
                <div className="pa-controls">
                  {['maintain', 'pause', 'resume'].map((action, i) => (
                    <button
                      key={action}
                      disabled={busy}
                      onClick={() => recover({ kind: 'index', indexId: item.id, action })}
                    >
                      {['整理一次', '暂停维护', '恢复维护'][i]}
                    </button>
                  ))}
                </div>
              </article>
            ))}
            {!(data.memory?.indexes ?? []).length && <p>尚无索引。</p>}
            <p>
              已注册来源：
              {(data.memory?.sources ?? []).map((s: any) => s.name || s.id).join('、') || '暂无'}
            </p>
          </section>
          <section>
            <h3>持续任务</h3>
            {data.tasks?.error && <p role="alert">{data.tasks.error}</p>}
            {(data.tasks?.items ?? []).map((task: any) => (
              <article key={task.id}>
                <strong>{task.title}</strong>
                <p>
                  {task.status} · {task.summary || task.waitingFor || ''}
                </p>
                <div className="pa-controls">
                  {onOpenSession && (
                    <button
                      onClick={() => {
                        void openTask(task.sessionId);
                      }}
                    >
                      打开任务会话
                    </button>
                  )}
                  {['resume', 'pause', 'cancel', 'check'].map((action, i) => (
                    <button
                      key={action}
                      disabled={busy}
                      onClick={() => recover({ kind: 'task', id: task.id, action })}
                    >
                      {['恢复', '暂停', '取消', '检查'][i]}
                    </button>
                  ))}
                </div>
              </article>
            ))}
            {!(data.tasks?.items ?? []).length && <p>尚无委派任务。</p>}
            {(data.tasks?.legacy ?? []).map((task: any) => (
              <article key={task.id}>
                {task.title}{' '}
                <button
                  disabled={busy}
                  onClick={() => {
                    void act('assistant.adopt-task', { id: task.id });
                  }}
                >
                  接入此助手
                </button>
              </article>
            ))}
            {(data.tasks?.pending ?? []).map((item: any) => (
              <article key={item.taskKey}>
                {item.message}
                <button
                  disabled={busy}
                  onClick={() => recover({ kind: 'delegation', taskKey: item.taskKey })}
                >
                  恢复委派
                </button>
              </article>
            ))}
            {(data.tasks?.notifications ?? []).map((item: any) => (
              <article key={item.id}>
                {item.error || '反馈待送达'}
                {item.id && (
                  <button
                    disabled={busy}
                    onClick={() => recover({ kind: 'feedback', notificationId: item.id })}
                  >
                    重试反馈
                  </button>
                )}
              </article>
            ))}
          </section>
          {data.sourceSync?.installed && (
            <section>
              <h3>飞书来源</h3>
              <p>飞书仍由来源插件管理；仅在授权后同步。</p>
              {data.sourceSync.error && <p role="alert">{data.sourceSync.error}</p>}
              <div className="pa-controls">
                {['enable', 'pause', 'check'].map((action, i) => (
                  <button
                    key={action}
                    disabled={busy}
                    onClick={() => recover({ kind: 'source', action })}
                  >
                    {['启用同步', '暂停同步', '同步一次'][i]}
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
