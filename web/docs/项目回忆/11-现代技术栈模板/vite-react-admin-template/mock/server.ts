import type { Plugin } from 'vite';

/**
 * 开发期 mock 中间件（对标原模板 data/*.json 的角色）。
 * 故意用 snake_case 字段名，用于验证请求层的 camel2Under / under2Camel 链路。
 * 对接真实后端时在 vite.config.ts 移除 mockApi() 即可。
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const permissionTree = [
  {
    key: 'dashboard',
    type: 'menu',
    title: '仪表盘',
    target: '/dashboard',
  },
  {
    key: 'users',
    type: 'menu',
    title: '用户管理',
    target: '/users',
    children: [
      { key: 'btn:user:create', type: 'btn', title: '新增用户', target: 'btn:user:create' },
      { key: 'btn:user:export', type: 'btn', title: '导出用户', target: 'btn:user:export' },
    ],
  },
];

const allUsers = Array.from({ length: 42 }, (_, i) => ({
  id: i + 1,
  user_name: ['张伟', '王芳', '李娜', '刘洋', '陈静'][i % 5] + (i + 1),
  email: `user${i + 1}@example.com`,
  status: i % 7 === 3 ? 'disabled' : 'active',
  created_at: `2026-08-${String((i % 28) + 1).padStart(2, '0')} 10:${String(i % 60).padStart(2, '0')}:00`,
}));

const ok = (info: unknown) => ({ code: '0', msg: 'ok', info });

function send(res: import('node:http').ServerResponse, payload: unknown) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

export function mockApi(): Plugin {
  return {
    name: 'mock-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api', (req, res, next) => {
        void (async () => {
          const url = req.originalUrl ?? req.url ?? '';
          const path = url.replace(/^\/api/, '').split('?')[0];
          const query = new URLSearchParams(url.split('?')[1] ?? '');

          await delay(200); // 模拟网络延迟，方便确认 loading 效果

          if (path === '/admin/user-info') {
            return send(res, ok({
              employee_id: '10086',
              name: '关天豪',
              en_name: 'ggbdpq',
              role_list: ['admin'],
            }));
          }

          if (path === '/admin/permission') {
            return send(res, ok(permissionTree));
          }

          if (path === '/admin/dashboard-stats') {
            return send(res, ok({
              total_users: allUsers.length,
              active_users: allUsers.filter((u) => u.status === 'active').length,
              today_orders: 128,
              success_rate: 99.2,
            }));
          }

          if (path === '/admin/users') {
            const pageNum = Number(query.get('page_num') ?? 1);
            const pageSize = Number(query.get('page_size') ?? 10);
            const keyword = (query.get('keyword') ?? '').toLowerCase();
            const filtered = allUsers.filter(
              (u) => !keyword || u.user_name.toLowerCase().includes(keyword) || u.email.includes(keyword),
            );
            const start = (pageNum - 1) * pageSize;
            return send(res, ok({
              list: filtered.slice(start, start + pageSize),
              meta: { count: filtered.length },
            }));
          }

          if (path === '/admin/logout') {
            await readBody(req);
            return send(res, ok({ layout_url: '/' }));
          }

          next();
        })();
      });
    },
  };
}
