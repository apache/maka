import { db } from '@/server/db';
import { guard, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:operlog:list'); if (forbidden) return forbidden;
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const rows = db.prepare('SELECT * FROM sys_oper_log ORDER BY oper_id DESC LIMIT 50 OFFSET ?').all((page - 1) * 50);
  const total = (db.prepare('SELECT COUNT(*) AS n FROM sys_oper_log').get() as { n: number }).n;
  return ok({ rows, total, page });
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:operlog:remove'); if (forbidden) return forbidden;
  if (new URL(req.url).searchParams.get('all') === '1') {
    db.prepare('DELETE FROM sys_oper_log').run();
    return ok({ cleared: true });
  }
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return ok({ error: '缺少 id' });
  db.prepare('DELETE FROM sys_oper_log WHERE oper_id = ?').run(id);
  return ok();
}
