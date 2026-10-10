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

window.__MakaModuleLoader__.load({
  id: 'dev.maka.index-initiative',
  factory(require) {
    const React = require('react'),
      h = React.createElement;
    const { SideNavItem } = require('@maka/ui/client-plugin');
    return {
      apply(ctx) {
        let open = false,
          navigate,
          opening,
          candidate;
        const listeners = new Set(),
          errors = new Set();
        const show = (value) => {
          open = value;
          for (const fn of listeners) fn(value);
        };
        const runtimeId = (id) => {
          try {
            const key = JSON.parse(id);
            if (Array.isArray(key) && key.length === 2) return key[1];
          } catch {}
          return id;
        };
        const hostId = (id) => {
          try {
            const key = JSON.parse(id);
            if (Array.isArray(key) && key.length === 2) return key[0];
          } catch {}
          return null;
        };
        const openChat = () => {
          if (opening) return opening;
          opening = (async () => {
            if (!navigate) throw Error('当前客户端不支持打开原生聊天，请更新 Maka。');
            const sessions = window.maka?.sessions;
            if (!sessions?.list || !sessions?.create) throw Error('会话服务尚未就绪。');
            let { state } = await ctx.remote.call('assistant.binding', {});
            if (!state) {
              candidate ??= await sessions.create({
                name: '个人助手',
                labels: ['personal-assistant'],
              });
              state = await ctx.remote.call('assistant.bind', {
                sessionId: runtimeId(candidate.id),
              });
            }
            const activeHost = await window.maka.runtimeHostProfiles?.getDefaultHost?.();
            const catalog = await sessions.list();
            const matches = [...catalog, ...(candidate ? [candidate] : [])].filter(
              (s) =>
                runtimeId(s.id) === state.sessionId &&
                (!hostId(s.id) || hostId(s.id) === activeHost?.hostId),
            );
            const ids = [...new Set(matches.map((s) => s.id))];
            if (ids.length !== 1)
              throw Error(
                '找不到此 Host 的助手会话。请确认 Host 在线且会话未删除；不会另建会话丢失原记录。',
              );
            navigate(ids[0]);
            return ids[0];
          })().finally(() => {
            opening = undefined;
          });
          return opening;
        };
        const time = (value) =>
          value
            ? new Date(value).toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })
            : '尚无';
        const statuses = {
          active: '执行中',
          waiting: '等待外部进展',
          paused: '已暂停',
          completed: '已完成',
          cancelled: '已取消',
        };
        const freshness = {
          updating: '整理中',
          check_failed: '来源检查失败',
          maintenance_failed: '整理失败',
          unknown: '尚未检查',
          pending: '有未整理信息',
          no_changes_at_last_check: '上次检查无新增',
        };
        function Panel() {
          const [visible, setVisible] = React.useState(open),
            [data, setData] = React.useState(null),
            [error, setError] = React.useState(''),
            [busy, setBusy] = React.useState(false),
            [selected, setSelected] = React.useState(null),
            interval = React.useRef(null);
          React.useEffect(() => {
            listeners.add(setVisible);
            errors.add(setError);
            return () => {
              listeners.delete(setVisible);
              errors.delete(setError);
            };
          }, []);
          React.useEffect(() => {
            if (!visible) return;
            let live = true,
              timer,
              readMemory = true;
            const poll = async () => {
              try {
                const value = await ctx.remote.call('assistant.status', {
                  includeMemory: readMemory,
                });
                if (live) {
                  setData((prior) => ({ ...prior, ...value }));
                  if (value.state) readMemory = false;
                }
              } catch (e) {
                if (live) setError('无法读取助手状态：' + e.message);
              } finally {
                if (live) timer = setTimeout(poll, 5000);
              }
            };
            void poll();
            return () => {
              live = false;
              clearTimeout(timer);
            };
          }, [visible]);
          const act = async (fn) => {
            setBusy(true);
            setError('');
            try {
              await fn();
              const value = await ctx.remote.call('assistant.status', { includeMemory: false });
              setData((prior) => ({ ...prior, ...value }));
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          };
          const control = (action) =>
            act(() =>
              ctx.remote.call('assistant.control', {
                action,
                ...(action === 'enable'
                  ? { intervalMinutes: Number(interval.current?.value || 30) }
                  : {}),
              }),
            );
          if (!visible) return null;
          const state = data?.state,
            memory = data?.memory,
            tasks = data?.tasks;
          const task = tasks?.items.find((t) => t.id === selected);
          return h(
            'aside',
            { className: 'pa-panel', 'aria-label': '个人助手状态' },
            h(
              'header',
              {},
              h('strong', {}, '个人助手'),
              h('button', { onClick: () => show(false), 'aria-label': '收起助手状态' }, '×'),
            ),
            h('p', { className: 'pa-muted' }, '在主聊天中交代事情，进展和主动消息也会回到那里。'),
            h(
              'button',
              { className: 'pa-primary', disabled: busy, onClick: () => act(openChat) },
              state ? '回到助手聊天' : '开始聊天',
            ),
            !state &&
              h(
                'p',
                {},
                '无需导入历史，也无需先建立索引。先聊起来，连接来源和整理记忆都可以之后再做。',
              ),
            error && h('p', { role: 'alert', className: 'pa-error' }, error),
            !data && h('p', { role: 'status' }, '正在读取状态…'),
            state &&
              h(
                'section',
                {},
                h('h3', {}, '主动发现'),
                h(
                  'p',
                  {},
                  state.lastError
                    ? '需要处理 · 自动检查已停止或延后'
                    : state.active
                      ? '正在探索'
                      : state.enabled
                        ? '已开启'
                        : '未开启 / 已暂停',
                ),
                state.lastError &&
                  h('details', {}, h('summary', {}, '查看原因'), h('p', {}, state.lastError)),
                h(
                  'p',
                  { className: 'pa-muted' },
                  `上次完成 ${time(state.lastCheckedAt)}${state.enabled ? ' · 下次 ' + time(state.nextAt) : ''}`,
                ),
                !state.enabled &&
                  h(
                    'label',
                    {},
                    '检查间隔（分钟） ',
                    h('input', {
                      ref: interval,
                      type: 'number',
                      min: 1,
                      max: 10080,
                      defaultValue: state.intervalMs / 60000,
                    }),
                  ),
                h(
                  'div',
                  { className: 'pa-actions' },
                  h(
                    'button',
                    {
                      disabled: busy || (!!state.active && !state.enabled),
                      onClick: () => control(state.enabled ? 'pause' : 'enable'),
                    },
                    state.enabled ? '暂停主动发现' : '开启并立即检查',
                  ),
                  state.enabled &&
                    h(
                      'button',
                      { disabled: busy || !!state.active, onClick: () => control('check') },
                      '现在检查',
                    ),
                ),
                h(
                  'small',
                  {},
                  'Host 运行时检查；没有值得交流的发现会保持安静。暂停主动发现不影响聊天和已交代的任务。',
                ),
              ),
            h(
              'section',
              {},
              h('h3', {}, '任务进展'),
              tasks && !tasks.installed && h('p', {}, '尚未安装持续跟进插件，普通聊天仍可使用。'),
              tasks?.installed &&
                !tasks.items.length &&
                h('p', { className: 'pa-muted' }, '还没有任务。直接在主聊天中交代要做的事情。'),
              ...(tasks?.items || []).map((t) =>
                h(
                  'button',
                  {
                    className: 'pa-task',
                    key: t.id,
                    onClick: () => setSelected(selected === t.id ? null : t.id),
                  },
                  h('strong', {}, t.title),
                  h(
                    'small',
                    {},
                    `${statuses[t.status] || t.status}${t.wakes?.length ? ' · 下次 ' + time(Math.min(...t.wakes.map((w) => w.at))) : ''}`,
                  ),
                ),
              ),
              task &&
                h(
                  'div',
                  { className: 'pa-detail' },
                  h('p', {}, task.updates?.[0]?.text || task.state || '已接收，正在开始执行。'),
                  task.waitingFor && h('p', {}, '等待：' + task.waitingFor),
                  task.lastError && h('p', { className: 'pa-error' }, task.lastError),
                  h('small', {}, '补充要求、暂停或取消，请直接告诉主聊天中的助手。'),
                ),
              ...(tasks?.notifications || [])
                .filter((n) => n.error)
                .map((n, i) => h('p', { key: i, className: 'pa-error' }, '任务反馈：' + n.error)),
              !!tasks?.legacy?.length &&
                h(
                  'details',
                  {},
                  h('summary', {}, `以前的独立任务（${tasks.legacy.length}）`),
                  ...tasks.legacy.map((t) =>
                    h(
                      'div',
                      { key: t.id, className: 'pa-task' },
                      h('span', {}, t.title),
                      h(
                        'button',
                        {
                          disabled: busy || !state,
                          onClick: () =>
                            act(() => ctx.remote.call('assistant.adopt-task', { id: t.id })),
                        },
                        '交给此助手跟进',
                      ),
                    ),
                  ),
                ),
            ),
            h(
              'section',
              {},
              h('h3', {}, '信息与记忆'),
              h(
                'button',
                {
                  disabled: busy,
                  onClick: () =>
                    act(async () => {
                      const value = await ctx.remote.call('assistant.status', {
                        includeMemory: true,
                      });
                      setData((prior) => ({ ...prior, ...value }));
                    }),
                },
                '刷新记忆状态',
              ),
              memory && !memory.installed && h('p', {}, '记忆插件未安装，仍然可以聊天。'),
              memory?.error &&
                h('p', { className: 'pa-error' }, '记忆状态读取失败：' + memory.error),
              memory?.installed &&
                h(
                  React.Fragment,
                  {},
                  h('p', { className: 'pa-muted' }, '历史导入可选；这里不会自动导入或启动整理。'),
                  h(
                    'p',
                    {},
                    '已注册来源：' +
                      ((memory.sources || [])
                        .map((s) =>
                          s.id === 'maka'
                            ? 'Maka 对话'
                            : s.id.startsWith('feishu.')
                              ? '飞书 · ' +
                                ({
                                  messages: '聊天',
                                  calendar: '日历',
                                  tasks: '任务',
                                  documents: '文档',
                                }[s.id.split('.').at(-1)] || s.id)
                              : s.description || s.id,
                        )
                        .join('、') || '打开助手后查看'),
                  ),
                  !memory.indexes?.length &&
                    h(
                      'p',
                      {},
                      '尚无索引。可以先正常使用；需要时在聊天中说明想记住什么、允许整理哪些来源。',
                    ),
                  ...(memory.indexes || []).map((i) =>
                    h(
                      'div',
                      { key: i.id, className: 'pa-task' },
                      h('strong', {}, i.name || '不可访问的索引'),
                      h(
                        'small',
                        {},
                        i.unavailable
                          ? '暂时不可读取（权限或来源连接）'
                          : `${freshness[i.freshness.status] || '状态未知'} · 整理于 ${time(i.freshness.lastOrganizedAt)}`,
                      ),
                    ),
                  ),
                  h(
                    'small',
                    {},
                    '飞书为可选来源：在扩展中安装「飞书只读 Source」，完成 CLI 授权并设置范围。已注册不代表授权有效；日历只覆盖配置的时间窗口。',
                  ),
                ),
            ),
          );
        }
        function Entry({ openSession }) {
          const [issue, setIssue] = React.useState(false);
          React.useEffect(() => {
            let live = true,
              timer;
            const poll = async () => {
              try {
                const { state } = await ctx.remote.call('assistant.binding', {});
                if (live) setIssue(!!state?.lastError);
              } catch {
                if (live) setIssue(true);
              } finally {
                if (live) timer = setTimeout(poll, 10000);
              }
            };
            void poll();
            return () => {
              live = false;
              clearTimeout(timer);
            };
          }, []);
          return h(SideNavItem, {
            icon: () =>
              h(
                'svg',
                {
                  width: 18,
                  height: 18,
                  viewBox: '0 0 24 24',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.5,
                  'aria-hidden': true,
                },
                h('path', { d: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z' }),
              ),
            endContent: issue
              ? h(
                  'span',
                  {
                    title: '助手需要处理，请打开查看',
                    'aria-label': '助手需要处理',
                    style: { color: '#b34a54' },
                  },
                  '●',
                )
              : undefined,
            'aria-label': '个人助手',
            label: '个人助手',
            size: 'md',
            onClick: () => {
              navigate = openSession;
              show(true);
              void openChat().catch((e) => {
                for (const fn of errors) fn(e.message);
              });
            },
          });
        }
        ctx.slots.register(
          { name: 'sidebar.navigation', id: 'personal-assistant', order: 40 },
          Entry,
        );
        ctx.slots.register(
          { name: 'shell.overlay', id: 'personal-assistant-status', order: 40 },
          Panel,
        );
        ctx.style(
          `.pa-panel{position:fixed;right:24px;top:80px;width:min(360px,calc(100vw - 32px));max-height:calc(100dvh - 104px);overflow:auto;background:var(--background,#fff);color:var(--foreground,#292929);border:1px solid #8883;border-radius:22px;box-shadow:0 8px 32px #0001;padding:22px;z-index:1000;font-size:13px;line-height:1.65}.pa-panel header{display:flex;justify-content:space-between;font-size:17px}.pa-panel section{border-top:1px solid #8882;margin-top:18px;padding-top:12px}.pa-panel h3{font-size:13px;margin:0 0 8px}.pa-panel p{margin:8px 0;overflow-wrap:anywhere;white-space:pre-wrap}.pa-panel button{font:inherit;cursor:pointer;border:1px solid #8883;border-radius:9px;background:transparent;color:inherit;padding:6px 10px}.pa-panel button:disabled{opacity:.5;cursor:default}.pa-panel button:focus-visible{outline:2px solid #648f76}.pa-panel .pa-primary{background:#527965;color:white;border:0}.pa-muted,.pa-panel small{opacity:.65}.pa-error{color:#b34a54}.pa-actions{display:flex;gap:8px;margin:10px 0}.pa-task{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;margin:7px 0;padding:9px 0}.pa-detail{border-left:2px solid #648f76;padding-left:12px}.pa-panel input{width:70px;color:inherit;background:transparent;border:1px solid #8883;border-radius:5px;padding:4px}.pa-panel details{margin:10px 0}`,
        );
      },
    };
  },
});
