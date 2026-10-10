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
            [settingsOpen, setSettingsOpen] = React.useState(false),
            [memoryOpen, setMemoryOpen] = React.useState(false),
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
              const value = await ctx.remote.call('assistant.status', {
                includeMemory: false,
              });
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
          const items = tasks?.items || [];
          const active = items.filter((t) => !['completed', 'cancelled'].includes(t.status));
          const finished = items.filter((t) => ['completed', 'cancelled'].includes(t.status));
          const summary = (t) =>
            String(
              t.updates?.[0]?.text || t.waitingFor || t.state || statuses[t.status] || '已接收',
            )
              .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
              .replace(/[*_`#]/g, '')
              .trim();
          const next = (t) => {
            if (!['active', 'waiting'].includes(t.status)) return null;
            const times = (t.wakes || []).map((w) => w.at).filter(Number.isFinite);
            return times.length ? Math.min(...times) : null;
          };
          const row = (t) =>
            h(
              'button',
              {
                key: t.id,
                className: 'pa-task',
                onClick: () => setSelected(t.id),
                'aria-label': `查看任务：${t.title}`,
              },
              h(
                'span',
                { className: 'pa-task-mark', 'aria-hidden': true },
                t.status === 'completed' ? '✓' : t.status === 'active' ? '◌' : '○',
              ),
              h(
                'span',
                { className: 'pa-task-copy' },
                h('strong', {}, t.title),
                h('span', { className: 'pa-task-summary' }, summary(t)),
              ),
              h(
                'span',
                { className: 'pa-task-time' },
                next(t)
                  ? h(React.Fragment, {}, h('span', {}, '下次检查'), h('span', {}, time(next(t))))
                  : statuses[t.status] || t.status,
              ),
            );
          const memoryIssue =
            memory?.error ||
            memory?.indexes?.some(
              (i) =>
                i.unavailable ||
                ['check_failed', 'maintenance_failed'].includes(i.freshness?.status),
            );
          return h(
            'aside',
            { className: 'pa-panel', 'aria-label': '个人助手状态' },
            h(
              'header',
              {},
              h('span', { className: 'pa-spark', 'aria-hidden': true }, '✧'),
              h('strong', {}, '助手动态'),
              h(
                'button',
                {
                  className: 'pa-icon',
                  onClick: () => setSettingsOpen(!settingsOpen),
                  'aria-label': '助手设置',
                  'aria-expanded': settingsOpen,
                  'aria-controls': 'pa-settings',
                  disabled: !state,
                },
                h(
                  'svg',
                  {
                    width: 16,
                    height: 16,
                    viewBox: '0 0 24 24',
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 1.5,
                    'aria-hidden': true,
                  },
                  h('path', { d: 'M3 7h8m4 0h6M3 17h3m4 0h11' }),
                  h('circle', { cx: 13, cy: 7, r: 2 }),
                  h('circle', { cx: 8, cy: 17, r: 2 }),
                ),
              ),
              h(
                'button',
                {
                  className: 'pa-icon',
                  onClick: () => show(false),
                  'aria-label': '收起助手状态',
                },
                '−',
              ),
            ),
            h(
              'div',
              { className: 'pa-status', role: 'status' },
              h('span', {
                className: 'pa-dot',
                'data-state':
                  state?.lastError || error ? 'error' : state?.enabled ? 'enabled' : 'off',
                'aria-hidden': true,
              }),
              h(
                'span',
                {},
                !data
                  ? '正在读取状态…'
                  : !state
                    ? '正在连接助手聊天…'
                    : state.lastError
                      ? '主动发现需要处理'
                      : state.active
                        ? '正在探索'
                        : state.enabled
                          ? '主动发现已开启'
                          : '主动发现未开启 / 已暂停',
              ),
              state?.enabled &&
                !state.active &&
                state.nextAt &&
                h('span', { className: 'pa-next' }, `下次 ${time(state.nextAt)}`),
            ),
            error && h('p', { role: 'alert', className: 'pa-error pa-inset' }, error),
            state?.lastError &&
              h(
                'details',
                { className: 'pa-inset pa-error' },
                h('summary', {}, '查看检查异常'),
                h('p', {}, state.lastError),
              ),
            state &&
              settingsOpen &&
              h(
                'section',
                { className: 'pa-settings', id: 'pa-settings' },
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
                      {
                        disabled: busy || !!state.active,
                        onClick: () => control('check'),
                      },
                      '现在检查',
                    ),
                ),
                h('small', {}, 'Maka 的 Host 运行时检查。暂停主动发现不影响聊天和已交代的任务。'),
              ),
            tasks?.error &&
              h(
                'p',
                { role: 'alert', className: 'pa-error pa-inset' },
                '任务读取失败：' + tasks.error,
              ),
            ...(tasks?.notifications || [])
              .filter((n) => n.error)
              .map((n, i) =>
                h('p', { key: i, className: 'pa-error pa-inset' }, '任务反馈：' + n.error),
              ),
            task
              ? h(
                  'section',
                  { className: 'pa-detail' },
                  h(
                    'button',
                    { className: 'pa-back', onClick: () => setSelected(null) },
                    '‹ 返回跟进列表',
                  ),
                  h('h3', {}, task.title),
                  h(
                    'div',
                    { className: 'pa-step' },
                    h('small', {}, statuses[task.status] || task.status),
                    h('p', {}, task.updates?.[0]?.text || task.state || '已接收，正在开始执行。'),
                  ),
                  task.waitingFor &&
                    h(
                      'div',
                      { className: 'pa-step' },
                      h('small', {}, '等待'),
                      h('p', {}, task.waitingFor),
                    ),
                  next(task) &&
                    h(
                      'div',
                      { className: 'pa-step' },
                      h('small', {}, '下次检查'),
                      h('p', {}, time(next(task))),
                    ),
                  task.lastError && h('p', { className: 'pa-error' }, task.lastError),
                  h('small', {}, '补充要求、暂停或取消，直接在聊天中告诉助手。'),
                )
              : h(
                  'section',
                  { className: 'pa-tasks' },
                  h(
                    'div',
                    { className: 'pa-section-title' },
                    h('span', {}, '正在跟进'),
                    h('span', {}, active.length),
                  ),
                  ...active.map(row),
                  tasks?.installed &&
                    !tasks.error &&
                    !active.length &&
                    h(
                      'div',
                      { className: 'pa-empty' },
                      h('strong', {}, '暂时没有正在跟进的事'),
                      h('p', {}, '在聊天里交代事情，进展会出现在这里。'),
                      !memory?.indexes?.length && h('small', {}, '无需先导入历史或建立记忆。'),
                    ),
                  tasks &&
                    !tasks.installed &&
                    h(
                      'p',
                      { className: 'pa-inset pa-muted' },
                      '尚未安装持续跟进插件，普通聊天仍可使用。',
                    ),
                  !!finished.length &&
                    h(
                      'details',
                      { className: 'pa-history' },
                      h('summary', {}, `已结束 · ${finished.length}`),
                      ...finished.map(row),
                    ),
                  !!tasks?.legacy?.length &&
                    h(
                      'details',
                      { className: 'pa-history' },
                      h('summary', {}, `以前的独立任务 · ${tasks.legacy.length}`),
                      ...tasks.legacy.map((t) =>
                        h(
                          'div',
                          { className: 'pa-legacy', key: t.id },
                          h('span', {}, t.title),
                          h(
                            'button',
                            {
                              disabled: busy || !state,
                              onClick: () =>
                                act(() =>
                                  ctx.remote.call('assistant.adopt-task', {
                                    id: t.id,
                                  }),
                                ),
                            },
                            '交给此助手跟进',
                          ),
                        ),
                      ),
                    ),
                ),
            h(
              'footer',
              {},
              h(
                'button',
                {
                  onClick: () => setMemoryOpen(!memoryOpen),
                  'aria-expanded': memoryOpen,
                  'aria-controls': 'pa-memory',
                },
                '记忆与来源',
                memoryIssue && h('span', { className: 'pa-error' }, ' · 需要处理'),
              ),
              h(
                'span',
                {},
                !memory
                  ? '尚未读取'
                  : !memory.installed
                    ? '未安装'
                    : memoryIssue
                      ? '检查异常'
                      : memory.indexes?.length
                        ? `${memory.indexes.length} 个索引`
                        : '尚无索引',
              ),
            ),
            memoryOpen &&
              h(
                'section',
                { className: 'pa-memory', id: 'pa-memory' },
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
                        { key: i.id, className: 'pa-index' },
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
                h('path', {
                  d: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
                }),
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
          `.pa-panel{--pa-line:color-mix(in srgb,var(--foreground,#292929) 10%,transparent);--pa-muted:var(--muted-foreground,#777b83);--pa-hover:color-mix(in srgb,var(--foreground,#292929) 4%,transparent);position:fixed;box-sizing:border-box;right:24px;top:80px;width:min(348px,calc(100vw - 32px));max-height:calc(100dvh - 104px);overflow:auto;background:var(--background,#fff);color:var(--foreground,#292929);border:1px solid var(--pa-line);border-radius:14px;box-shadow:0 10px 35px #18202c12,0 2px 6px #18202c0a;z-index:1000;font-size:13px;line-height:1.5;color-scheme:inherit}
.pa-panel header{display:flex;align-items:center;gap:8px;padding:12px 12px 8px 16px}.pa-panel header strong{font-size:14px;font-weight:500;flex:1}.pa-spark{font-size:20px}.pa-panel button{font:inherit;cursor:pointer;border:0;border-radius:6px;background:transparent;color:inherit;padding:5px 7px;text-align:left}.pa-panel button:hover{background:var(--pa-hover)}.pa-panel button:disabled{opacity:.5;cursor:default}.pa-panel button:focus-visible,.pa-panel summary:focus-visible{outline:2px solid var(--ring,#648f76);outline-offset:-2px}.pa-panel .pa-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;font-size:18px;color:var(--pa-muted)}
.pa-status{display:flex;align-items:center;flex-wrap:wrap;gap:7px;padding:0 16px 14px;font-size:11px;color:var(--pa-muted)}.pa-dot{width:6px;height:6px;flex-shrink:0;border-radius:50%;background:var(--pa-muted)}.pa-dot[data-state=enabled]{background:var(--success,#527965)}.pa-dot[data-state=error]{background:var(--destructive,#b34a54)}.pa-next{margin-left:auto;font-variant-numeric:tabular-nums}.pa-panel p{margin:7px 0;overflow-wrap:anywhere;white-space:pre-wrap}.pa-panel small,.pa-muted{color:var(--pa-muted);font-size:11px}.pa-panel .pa-error{color:var(--destructive,#b34a54)}.pa-panel .pa-inset{margin:10px 16px}.pa-panel h3{font-size:13px;font-weight:500;margin:0 0 8px}.pa-settings,.pa-memory{padding:14px 16px;border-top:1px solid var(--pa-line)}.pa-settings label{font-size:12px}.pa-panel input{box-sizing:border-box;width:70px;color:inherit;background:var(--pa-hover);border:1px solid var(--pa-line);border-radius:6px;padding:5px;font:inherit}.pa-actions{display:flex;gap:8px;margin:10px 0}.pa-actions button,.pa-memory>button,.pa-legacy button{border:1px solid var(--pa-line)}
.pa-tasks,.pa-detail{border-top:1px solid var(--pa-line)}.pa-section-title{display:flex;justify-content:space-between;padding:12px 16px 4px;font-size:11px;color:var(--pa-muted)}.pa-panel .pa-task{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:start;gap:9px;width:100%;padding:12px 16px;border-radius:0}.pa-task-mark{color:var(--pa-muted);font-size:16px}.pa-task-copy{min-width:0}.pa-task strong{display:block;font-weight:500;overflow-wrap:anywhere}.pa-task-summary{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:3px;font-size:12px;color:var(--pa-muted);overflow-wrap:anywhere}.pa-task-time{max-width:90px;font-size:11px;color:var(--pa-muted);padding-top:2px;text-align:right;font-variant-numeric:tabular-nums}.pa-task-time>span{display:block;white-space:nowrap}.pa-empty{text-align:center;padding:24px 16px 28px;color:var(--pa-muted);font-size:12px}.pa-empty strong{display:block;color:var(--foreground,#292929);font-weight:500;font-size:13px}.pa-history{border-top:1px solid var(--pa-line);font-size:12px}.pa-panel summary{cursor:pointer}.pa-history>summary{padding:10px 16px;color:var(--pa-muted)}.pa-legacy{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:8px 16px}.pa-legacy>span{min-width:0;overflow-wrap:anywhere}.pa-legacy button{flex-shrink:0;font-size:11px}.pa-detail{padding:10px 16px 18px}.pa-panel .pa-back{padding:4px 0;margin-bottom:10px;color:var(--pa-muted);font-size:12px}.pa-detail h3{font-size:15px}.pa-step{border-left:1px solid var(--pa-line);padding-left:12px;margin:14px 0}.pa-panel footer{border-top:1px solid var(--pa-line);display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 12px;color:var(--pa-muted);font-size:11px}.pa-index{padding:10px 0;display:flex;flex-direction:column;gap:4px}.pa-index strong{font-weight:500}.pa-memory details{margin:10px 0}@media(max-width:480px){.pa-panel{right:16px;top:64px;max-height:calc(100dvh - 80px)}}@media(pointer:coarse){.pa-panel button,.pa-panel summary{min-height:44px}.pa-panel .pa-icon{width:44px;height:44px}.pa-panel input{font-size:16px}}`,
        );
      },
    };
  },
});
