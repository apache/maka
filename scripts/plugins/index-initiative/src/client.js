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
        let navigate, opening, candidate, assistantSessionId;
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
            assistantSessionId = ids[0];
            navigate(ids[0]);
            return ids[0];
          })().finally(() => {
            opening = undefined;
          });
          return opening;
        };
        const openTask = async (sessionId) => {
          const host = await window.maka.runtimeHostProfiles?.getDefaultHost?.();
          const matches = (await window.maka.sessions.list()).filter(
            (s) =>
              runtimeId(s.id) === sessionId && (!hostId(s.id) || hostId(s.id) === host?.hostId),
          );
          if (matches.length !== 1) throw Error('无法定位任务会话，请确认 Host 在线。');
          navigate(matches[0].id);
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
        function Settings() {
          const [data, setData] = React.useState(null),
            [error, setError] = React.useState(''),
            [busy, setBusy] = React.useState(false),
            [selected, setSelected] = React.useState(null),
            interval = React.useRef(null);
          React.useEffect(() => {
            let live = true,
              timer,
              readMemory = true,
              polls = 0;
            const poll = async () => {
              try {
                const value = await ctx.remote.call('assistant.status', {
                  includeMemory: readMemory || polls++ % 6 === 0,
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
          }, []);
          const act = async (fn) => {
            setBusy(true);
            setError('');
            try {
              await fn();
              const value = await ctx.remote.call('assistant.status', {
                includeMemory: true,
              });
              setData((prior) => ({ ...prior, ...value }));
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          };
          const recover = (input) => act(() => ctx.remote.call('assistant.recover', input));
          const control = (action) =>
            act(() =>
              ctx.remote.call('assistant.control', {
                action,
                ...(action === 'enable'
                  ? { intervalMinutes: Number(interval.current?.value || 30) }
                  : {}),
              }),
            );
          const state = data?.state,
            memory = data?.memory,
            tasks = data?.tasks,
            sourceSync = data?.sourceSync;
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
          return h(
            'section',
            {
              className: 'pa-panel pa-preferences',
              'aria-label': '个人助手设置',
            },
            h(
              'header',
              {},
              h('span', { className: 'pa-spark', 'aria-hidden': true }, '✧'),
              h('strong', {}, '个人助手'),
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
              h(
                'section',
                { className: 'pa-settings', id: 'pa-settings' },
                h('h3', {}, '主动发现'),
                h('p', { className: 'pa-muted' }, data?.readiness?.notice),
                h(
                  'small',
                  {},
                  `当前模型：${data?.readiness?.model || data?.readiness?.executor || '请在聊天中选择'}${data?.readiness?.connection ? ' · ' + data.readiness.connection : ''}`,
                ),
                data?.readiness?.sessionError &&
                  h('p', { className: 'pa-error' }, '助手会话读取失败，请检查 Host 连接。'),
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
            !state &&
              h(
                'p',
                { className: 'pa-inset pa-muted' },
                '从侧栏打开「个人助手」即可开始。无需导入历史或建立索引。',
              ),
            tasks?.error &&
              h(
                'p',
                { role: 'alert', className: 'pa-error pa-inset' },
                '任务读取失败：' + tasks.error,
              ),
            ...(tasks?.pending || []).map((p) =>
              h(
                'div',
                { key: p.taskKey, className: 'pa-inset' },
                h('strong', {}, p.title),
                h('p', {}, p.status === 'creating' ? '正在创建任务' : p.message),
                h(
                  'button',
                  {
                    disabled: busy || p.status === 'creating',
                    onClick: () => recover({ kind: 'delegation', taskKey: p.taskKey }),
                  },
                  '核对并恢复',
                ),
              ),
            ),
            ...(tasks?.notifications || [])
              .filter((n) => n.error)
              .map((n, i) =>
                h(
                  'div',
                  { key: i, className: 'pa-inset' },
                  h('p', { className: 'pa-error' }, '任务反馈：' + n.error),
                  n.id &&
                    h(
                      'button',
                      {
                        disabled: busy,
                        onClick: () => recover({ kind: 'feedback', notificationId: n.id }),
                      },
                      '核对并重试反馈',
                    ),
                ),
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
                  ['waiting_for_user', 'blocked'].includes(task.runtimeStatus) &&
                    h('p', { className: 'pa-error' }, '需要授权或补充信息，请打开任务会话处理。'),
                  task.retryAt && h('p', {}, `等待 Host 接收，下次重试 ${time(task.retryAt)}`),
                  task.runtimeError &&
                    h('p', { className: 'pa-error' }, '任务会话暂时不可用，请检查 Host。'),
                  h(
                    'div',
                    { className: 'pa-actions' },
                    h(
                      'button',
                      { disabled: busy, onClick: () => act(() => openTask(task.sessionId)) },
                      '打开任务会话',
                    ),
                    !['completed', 'cancelled'].includes(task.status) &&
                      h(
                        'button',
                        {
                          disabled: busy,
                          onClick: () =>
                            recover({
                              kind: 'task',
                              id: task.id,
                              action: task.status === 'paused' ? 'resume' : 'pause',
                            }),
                        },
                        task.status === 'paused' ? '恢复任务' : '暂停任务',
                      ),
                  ),
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
              'section',
              { className: 'pa-memory', id: 'pa-memory' },
              h('h3', {}, '信息与记忆'),
              sourceSync?.installed &&
                h(
                  'div',
                  {},
                  h('strong', {}, '飞书消息同步'),
                  h(
                    'p',
                    {},
                    sourceSync.schedule?.running
                      ? '同步中 · 仅完整批次发布'
                      : sourceSync.schedule?.enabled
                        ? `定期同步已开启 · 每 ${sourceSync.schedule.intervalMinutes} 分钟`
                        : '定期同步未开启',
                  ),
                  h(
                    'small',
                    {},
                    `最近成功 ${time(sourceSync.schedule?.lastSuccessAt || (sourceSync.status === 'complete' ? sourceSync.finishedAt : null))} · 下次 ${sourceSync.schedule?.enabled ? time(sourceSync.schedule.nextAt) : '未安排'}`,
                  ),
                  sourceSync.range &&
                    h(
                      'p',
                      { className: 'pa-muted' },
                      `最近批次范围 ${time(sourceSync.range.startTime * 1000)} — ${time(sourceSync.range.endTime * 1000)}`,
                    ),
                  (sourceSync.error || sourceSync.schedule?.error) &&
                    h(
                      'details',
                      { className: 'pa-error' },
                      h('summary', {}, '来源同步需要处理'),
                      h('p', {}, sourceSync.error || sourceSync.schedule?.error),
                      h(
                        'small',
                        {},
                        '授权或账号问题请在飞书 CLI 重新登录并核对扩展账号设置，然后重试。',
                      ),
                    ),
                  h(
                    'div',
                    { className: 'pa-actions' },
                    h(
                      'button',
                      {
                        disabled: busy,
                        onClick: () =>
                          recover({
                            kind: 'source',
                            action: sourceSync.schedule?.enabled ? 'pause' : 'enable',
                          }),
                      },
                      sourceSync.schedule?.enabled ? '暂停同步' : '开启定期同步',
                    ),
                    h(
                      'button',
                      {
                        disabled: busy || sourceSync.schedule?.running,
                        onClick: () => recover({ kind: 'source', action: 'check' }),
                      },
                      '同步一次',
                    ),
                  ),
                  h(
                    'small',
                    {},
                    '开启后默认每 30 分钟检查最近 24 小时；休眠后补查缺口。不会导入全部历史，也不保证更早消息的修改已同步。',
                  ),
                ),
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
                  h(
                    'p',
                    { className: 'pa-muted' },
                    '历史导入可选；打开面板不会自动导入或启动整理；点击「现在整理」会运行模型。',
                  ),
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
                      i.freshness &&
                        h(
                          'small',
                          {},
                          `来源观察 ${time(i.freshness.lastCheckedAt)} · 下次整理 ${i.freshness.maintenanceEnabled ? time(i.freshness.nextCheckAt) : '已暂停'}`,
                        ),
                      i.freshness?.lastMaintenanceError &&
                        h(
                          'details',
                          { className: 'pa-error' },
                          h('summary', {}, '整理需要处理'),
                          h('p', {}, i.freshness.lastMaintenanceError),
                        ),
                      !i.unavailable &&
                        h(
                          'div',
                          { className: 'pa-actions' },
                          h(
                            'button',
                            {
                              disabled: busy,
                              onClick: () =>
                                recover({
                                  kind: 'index',
                                  indexId: i.id,
                                  action: i.freshness?.maintenanceEnabled ? 'pause' : 'resume',
                                }),
                            },
                            i.freshness?.maintenanceEnabled ? '暂停维护' : '恢复维护',
                          ),
                          h(
                            'button',
                            {
                              disabled: busy || i.freshness?.status === 'updating',
                              onClick: () =>
                                recover({ kind: 'index', indexId: i.id, action: 'maintain' }),
                            },
                            '现在整理',
                          ),
                        ),
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

        function Entry(props) {
          const { openSession, activeSessionId } = props;
          const [issue, setIssue] = React.useState(''),
            [boundId, setBoundId] = React.useState(assistantSessionId);
          const selected = !!boundId && activeSessionId === boundId;
          React.useEffect(() => {
            navigate = openSession;
          }, [openSession]);
          React.useEffect(() => {
            let live = true,
              timer;
            const poll = async () => {
              try {
                const { state } = await ctx.remote.call('assistant.binding', {});
                const host = await window.maka.runtimeHostProfiles?.getDefaultHost?.();
                if (live) {
                  setIssue(state?.lastError || '');
                  setBoundId(
                    state
                      ? host?.hostId
                        ? JSON.stringify([host.hostId, state.sessionId])
                        : state.sessionId
                      : undefined,
                  );
                }
              } catch {
                if (live) setIssue('无法连接助手，请在设置 › 个人助手中检查。');
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
                    title: issue,
                    'aria-label': issue,
                    style: { color: '#b34a54' },
                  },
                  '●',
                )
              : undefined,
            isSelected: selected,
            'aria-label': '个人助手',
            label: '个人助手',
            size: 'md',
            onClick: () => {
              if (!Object.hasOwn(props, 'activeSessionId')) {
                setIssue('请同时更新 Maka 桌面端，以使用独立助手入口和专属会话列表。');
                return;
              }
              navigate = openSession;
              void openChat()
                .then((id) => {
                  setBoundId(id);
                  setIssue('');
                })
                .catch((e) => {
                  setIssue(e.message);
                });
            },
          });
        }
        ctx.slots.register(
          {
            name: 'sidebar.navigation',
            id: 'personal-assistant',
            order: 40,
            sessionLabels: ['personal-assistant'],
          },
          Entry,
        );
        ctx.slots.register(
          { name: 'settings.navigation', id: 'personal-assistant', order: 40 },
          ({ activePage, selectPage }) =>
            h(SideNavItem, {
              label: '个人助手',
              size: 'md',
              isSelected: activePage === 'personal-assistant',
              onClick: () => selectPage('personal-assistant'),
            }),
        );
        ctx.slots.register({ name: 'settings.page', key: 'personal-assistant' }, Settings);
        ctx.style(
          `.pa-preferences.pa-panel{position:static;width:100%;max-width:760px;max-height:none;overflow:visible;margin:24px auto;border:0;border-radius:0;box-shadow:none;z-index:auto}.pa-preferences header{padding:8px 16px 20px}.pa-preferences header strong{font-size:24px;font-weight:600}.pa-preferences .pa-settings,.pa-preferences .pa-memory{padding:24px 16px}.pa-preferences .pa-actions{flex-wrap:wrap}.pa-preferences .pa-status{font-size:13px}.pa-preferences small{font-size:12px}
.pa-panel{--pa-line:color-mix(in srgb,var(--foreground,#292929) 10%,transparent);--pa-muted:var(--muted-foreground,#777b83);--pa-hover:color-mix(in srgb,var(--foreground,#292929) 4%,transparent);box-sizing:border-box;background:var(--background,#fff);color:var(--foreground,#292929);border:1px solid var(--pa-line);border-radius:14px;box-shadow:0 10px 35px #18202c12,0 2px 6px #18202c0a;font-size:13px;line-height:1.5;color-scheme:inherit}
.pa-panel header{display:flex;align-items:center;gap:8px;padding:12px 12px 8px 16px}.pa-panel header strong{font-size:14px;font-weight:500;flex:1}.pa-spark{font-size:20px}.pa-panel button{font:inherit;cursor:pointer;border:0;border-radius:6px;background:transparent;color:inherit;padding:5px 7px;text-align:left}.pa-panel button:hover{background:var(--pa-hover)}.pa-panel button:disabled{opacity:.5;cursor:default}.pa-panel button:focus-visible,.pa-panel summary:focus-visible{outline:2px solid var(--ring,#648f76);outline-offset:-2px}
.pa-status{display:flex;align-items:center;flex-wrap:wrap;gap:7px;padding:0 16px 14px;font-size:11px;color:var(--pa-muted)}.pa-dot{width:6px;height:6px;flex-shrink:0;border-radius:50%;background:var(--pa-muted)}.pa-dot[data-state=enabled]{background:var(--success,#527965)}.pa-dot[data-state=error]{background:var(--destructive,#b34a54)}.pa-next{margin-left:auto;font-variant-numeric:tabular-nums}.pa-panel p{margin:7px 0;overflow-wrap:anywhere;white-space:pre-wrap}.pa-panel small,.pa-muted{color:var(--pa-muted);font-size:11px}.pa-panel .pa-error{color:var(--destructive,#b34a54)}.pa-panel .pa-inset{margin:10px 16px}.pa-panel h3{font-size:13px;font-weight:500;margin:0 0 8px}.pa-settings,.pa-memory{padding:14px 16px;border-top:1px solid var(--pa-line)}.pa-settings label{font-size:12px}.pa-panel input{box-sizing:border-box;width:70px;color:inherit;background:var(--pa-hover);border:1px solid var(--pa-line);border-radius:6px;padding:5px;font:inherit}.pa-actions{display:flex;gap:8px;margin:10px 0}.pa-actions button,.pa-memory>button,.pa-legacy button{border:1px solid var(--pa-line)}
.pa-tasks,.pa-detail{border-top:1px solid var(--pa-line)}.pa-section-title{display:flex;justify-content:space-between;padding:12px 16px 4px;font-size:11px;color:var(--pa-muted)}.pa-panel .pa-task{display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:start;gap:9px;width:100%;padding:12px 16px;border-radius:0}.pa-task-mark{color:var(--pa-muted);font-size:16px}.pa-task-copy{min-width:0}.pa-task strong{display:block;font-weight:500;overflow-wrap:anywhere}.pa-task-summary{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:3px;font-size:12px;color:var(--pa-muted);overflow-wrap:anywhere}.pa-task-time{max-width:90px;font-size:11px;color:var(--pa-muted);padding-top:2px;text-align:right;font-variant-numeric:tabular-nums}.pa-task-time>span{display:block;white-space:nowrap}.pa-empty{text-align:center;padding:24px 16px 28px;color:var(--pa-muted);font-size:12px}.pa-empty strong{display:block;color:var(--foreground,#292929);font-weight:500;font-size:13px}.pa-history{border-top:1px solid var(--pa-line);font-size:12px}.pa-panel summary{cursor:pointer}.pa-history>summary{padding:10px 16px;color:var(--pa-muted)}.pa-legacy{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:8px 16px}.pa-legacy>span{min-width:0;overflow-wrap:anywhere}.pa-legacy button{flex-shrink:0;font-size:11px}.pa-detail{padding:10px 16px 18px}.pa-panel .pa-back{padding:4px 0;margin-bottom:10px;color:var(--pa-muted);font-size:12px}.pa-detail h3{font-size:15px}.pa-step{border-left:1px solid var(--pa-line);padding-left:12px;margin:14px 0}.pa-index{padding:10px 0;display:flex;flex-direction:column;gap:4px}.pa-index strong{font-weight:500}.pa-memory details{margin:10px 0}@media(pointer:coarse){.pa-panel button,.pa-panel summary{min-height:44px}.pa-panel input{font-size:16px}}`,
        );
      },
    };
  },
});
