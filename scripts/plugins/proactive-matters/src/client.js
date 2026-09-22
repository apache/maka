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
  id: 'dev.maka.proactive-matters',
  factory(require) {
    const React = require('react'),
      h = React.createElement;
    return {
      apply(ctx) {
        let opened = false;
        const listeners = new Set();
        const toggle = () => {
          opened = !opened;
          for (const fn of listeners) fn(opened);
        };
        const labels = {
          active: '执行中',
          waiting: '等待下次检查',
          paused: '已暂停',
          completed: '已完成',
          cancelled: '已结束',
        };
        const icon = (name) =>
          h(
            'svg',
            {
              width: 16,
              height: 16,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
              'aria-hidden': true,
            },
            ...(name === 'clock'
              ? [
                  h('circle', { key: 0, cx: 12, cy: 12, r: 8 }),
                  h('path', { key: 1, d: 'M12 7v5l3 2' }),
                ]
              : [
                  h('path', {
                    key: 0,
                    d:
                      name === 'back'
                        ? 'm14 6-6 6 6 6'
                        : name === 'close'
                          ? 'm6 6 12 12M18 6 6 18'
                          : 'm9 5 7 7-7 7',
                  }),
                ]),
          );
        const plain = (value) =>
          String(value || '')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/\*\*|__|`/g, '')
            .trim();
        const nextAt = (m) =>
          ['completed', 'cancelled', 'paused'].includes(m.status)
            ? null
            : Math.min(...(m.wakes || []).map((w) => w.at).filter(Number.isFinite));
        const time = (at) => {
          if (!Number.isFinite(at)) return '尚未安排';
          const date = new Date(at),
            now = new Date();
          const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
          const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
          const prefix =
            day(date) === day(now)
              ? '今天'
              : day(date) === day(tomorrow)
                ? '明天'
                : date.toLocaleDateString('zh-CN', {
                    month: 'long',
                    day: 'numeric',
                    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
                  });
          return (
            prefix +
            ' ' +
            date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
          );
        };
        const schedule = (m) =>
          m.status === 'active'
            ? '正在执行'
            : m.status === 'waiting'
              ? Number.isFinite(nextAt(m))
                ? time(nextAt(m)) + ' · 下次检查'
                : '等待后续安排'
              : labels[m.status] || '等待中';
        function Panel() {
          const [visible, setVisible] = React.useState(opened),
            [data, setData] = React.useState({ matters: [], ready: false }),
            [error, setError] = React.useState(''),
            [selected, setSelected] = React.useState(null);
          React.useEffect(() => {
            listeners.add(setVisible);
            return () => listeners.delete(setVisible);
          }, []);
          React.useEffect(() => {
            if (!visible) return;
            const abort = new AbortController();
            setError('');
            (async () => {
              try {
                const initial = await ctx.remote.call('matters.list', {});
                if (abort.signal.aborted) return;
                setData(initial);
                for await (const value of ctx.remote.stream(
                  'matters.watch',
                  {},
                  { signal: abort.signal },
                )) {
                  if (abort.signal.aborted) break;
                  setData(value);
                }
              } catch (e) {
                if (!abort.signal.aborted) setError('暂时无法更新任务，请稍后重新打开。');
              }
            })();
            return () => abort.abort();
          }, [visible]);
          if (!visible) return null;
          const rank = { active: 0, waiting: 1, paused: 2, completed: 3, cancelled: 4 };
          const matters = [...data.matters].sort(
            (a, b) =>
              (rank[a.status] ?? 5) - (rank[b.status] ?? 5) ||
              (nextAt(a) || Infinity) - (nextAt(b) || Infinity),
          );
          const m = matters.find((m) => m.id === selected);
          const handoff = m?.handoff;
          const ended = m && ['completed', 'cancelled'].includes(m.status);
          const block = (title, content) =>
            h(
              'section',
              { className: 'mt-section' },
              h('h3', {}, title),
              h('p', {}, plain(content)),
            );
          return h(
            'aside',
            { className: 'mt-card', 'aria-label': '长任务' },
            h(
              'header',
              { className: 'mt-header' },
              m
                ? h(
                    'button',
                    { className: 'mt-back', onClick: () => setSelected(null) },
                    icon('back'),
                    '返回列表',
                  )
                : h(
                    'div',
                    { className: 'mt-heading' },
                    icon('clock'),
                    h('h2', {}, '长任务'),
                    h('span', { className: 'mt-count' }, matters.length),
                  ),
              h(
                'button',
                { className: 'mt-close', 'aria-label': '收起长任务', onClick: toggle },
                icon('close'),
              ),
            ),
            error && h('p', { className: 'mt-notice', role: 'status' }, error),
            !data.ready && !error && h('p', { className: 'mt-notice' }, '正在加载任务…'),
            data.error &&
              h('p', { className: 'mt-notice', role: 'status' }, '部分任务暂时无法更新。'),
            m
              ? h(
                  'div',
                  { className: 'mt-detail' },
                  h(
                    'div',
                    { className: 'mt-detail-title' },
                    h('h2', {}, m.title),
                    h(
                      'span',
                      { className: 'mt-status', 'data-status': m.status },
                      h('i', {}),
                      labels[m.status],
                    ),
                  ),
                  block(
                    '当前进展',
                    m.lastUpdate ||
                      handoff?.reason ||
                      (m.status === 'active'
                        ? '正在处理这件事，完成本轮后会更新进展。'
                        : '还没有新的进展。'),
                  ),
                  block('已经做了什么', handoff?.summary || '还没有已提交的执行记录。'),
                  h(
                    'section',
                    { className: 'mt-section' },
                    h('h3', {}, '接下来'),
                    ended
                      ? h(
                          'p',
                          {},
                          m.status === 'completed'
                            ? '任务已完成，不再安排检查。'
                            : '跟进已结束，不再安排检查。',
                        )
                      : m.status === 'paused'
                        ? h('p', {}, '任务已暂停，暂不执行后续安排。')
                        : h(
                            'div',
                            { className: 'mt-next' },
                            h(
                              'div',
                              { className: 'mt-time' },
                              icon('clock'),
                              m.status === 'active'
                                ? '本轮正在执行'
                                : Number.isFinite(nextAt(m))
                                  ? time(nextAt(m))
                                  : '尚未登记下次检查',
                            ),
                            h(
                              'p',
                              {},
                              plain(
                                handoff?.next ||
                                  (m.status === 'active'
                                    ? '根据本轮结果决定后续安排。'
                                    : '届时重新检查最新情况。'),
                              ),
                            ),
                            handoff?.next && h('small', {}, '后续安排会根据最新情况调整'),
                          ),
                  ),
                  h('footer', { className: 'mt-footnote' }, '时间按本机时区显示'),
                )
              : h(
                  'div',
                  { className: 'mt-list' },
                  !matters.length &&
                    data.ready &&
                    h(
                      'div',
                      { className: 'mt-empty' },
                      h('p', {}, '还没有长任务'),
                      h('span', {}, '在聊天中交代一件需要持续跟进的事，进展会显示在这里。'),
                    ),
                  ...matters.map((item) =>
                    h(
                      'button',
                      {
                        key: item.id,
                        className: 'mt-row',
                        onClick: () => setSelected(item.id),
                        'aria-label': '查看任务：' + item.title,
                      },
                      h('i', { className: 'mt-dot', 'data-status': item.status }),
                      h(
                        'span',
                        { className: 'mt-row-copy' },
                        h('strong', {}, item.title),
                        h('span', {}, schedule(item)),
                      ),
                      h('span', { className: 'mt-chevron' }, icon('next')),
                    ),
                  ),
                ),
          );
        }
        ctx.style(`
.mt-card{position:fixed;right:24px;top:88px;width:min(352px,calc(100vw - 32px));max-height:calc(100dvh - 112px);overflow:auto;box-sizing:border-box;padding:22px 24px 14px;background:var(--background,#fff);color:var(--foreground,#292929);border:1px solid color-mix(in srgb,currentColor 11%,transparent);border-radius:24px;box-shadow:0 4px 24px #00000009,0 1px 4px #00000004;z-index:1000;font-family:inherit;font-size:13px;line-height:1.65;text-align:left}
.mt-card *{box-sizing:border-box}.mt-card button,.mt-launch{font:inherit;color:inherit;cursor:pointer}.mt-card button{background:none;border:0;padding:0}.mt-card button:focus-visible,.mt-launch:focus-visible{outline:2px solid #6a8a79;outline-offset:4px;border-radius:6px}.mt-header,.mt-heading{display:flex;align-items:center}.mt-header{justify-content:space-between;margin-bottom:10px;min-height:24px}.mt-heading{gap:9px;color:color-mix(in srgb,currentColor 65%,transparent)}.mt-heading h2{font-size:14px;font-weight:600;margin:0}.mt-count{margin-left:2px;font-size:12px;opacity:.55}.mt-close{display:flex;align-items:center;justify-content:center;width:24px;height:24px;opacity:.4}.mt-close:hover{opacity:1}.mt-row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;min-height:82px!important;border-bottom:1px solid color-mix(in srgb,currentColor 7%,transparent)!important}.mt-row:last-child{border-bottom:0!important}.mt-row:hover .mt-row-copy strong{color:#527965}.mt-row-copy{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;padding:15px 0}.mt-row-copy strong{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mt-row-copy>span{font-size:12px;opacity:.5}.mt-chevron{display:flex;opacity:.28}.mt-dot,.mt-status i{display:inline-block;width:6px;height:6px;flex-shrink:0;border-radius:50%;background:#aaa}.mt-dot[data-status=active],.mt-status[data-status=active] i{background:#648f76;box-shadow:0 0 0 4px #648f7610}.mt-dot[data-status=waiting],.mt-status[data-status=waiting] i{background:#b09b78}.mt-dot[data-status=completed],.mt-status[data-status=completed] i{background:#8ba08e}.mt-back{display:flex;align-items:center;gap:6px;font-size:12px!important;opacity:.6}.mt-detail-title{padding:18px 0 20px;border-bottom:1px solid color-mix(in srgb,currentColor 8%,transparent)}.mt-detail-title h2{font-size:18px;line-height:1.5;font-weight:550;margin:0 0 10px;overflow-wrap:anywhere}.mt-status{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.65}.mt-section{margin:22px 0}.mt-section h3{font-size:11px;font-weight:500;opacity:.45;margin:0 0 8px;letter-spacing:.5px}.mt-section p{font-size:13px;line-height:1.85;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.mt-time{display:flex;align-items:center;gap:7px;color:#527965;font-size:13px;font-weight:500;margin-bottom:8px}.mt-next small{display:block;margin-top:10px;font-size:11px;opacity:.4}.mt-footnote{font-size:10px;opacity:.35;padding:6px 0 2px}.mt-notice{font-size:12px;opacity:.6}.mt-empty{padding:20px 0 24px}.mt-empty p{margin:0 0 8px}.mt-empty span{font-size:12px;opacity:.5}.mt-launch{display:flex;align-items:center;gap:8px;background:none;border:0;padding:8px 12px;border-radius:8px;font-size:13px}.mt-launch:hover{background:#8881}@media(max-width:600px){.mt-card{right:16px;top:64px;max-height:calc(100dvh - 80px)}}
      `);
        ctx.slots.register(
          { name: 'sidebar.footer', id: 'proactive-matters-open', order: 50 },
          () => h('button', { className: 'mt-launch', onClick: toggle }, icon('clock'), '长任务'),
        );
        ctx.slots.register(
          { name: 'shell.overlay', id: 'proactive-matters-panel', order: 50 },
          Panel,
        );
      },
    };
  },
});
