import { db } from '@/server/db';
import { guard, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:logininfor:list'); if (forbidden) return forbidden;
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const q = url.searchParams.get('q')?.trim();
  const where = q ? 'WHERE user_name LIKE @q OR ipaddr LIKE @q' : '';
  const bind: Record<string, string> = q ? { q: `%${q}%` } : {};
  const rows = db.prepare(`SELECT * FROM sys_logininfor ${where} ORDER BY info_id DESC LIMIT 50 OFFSET @off`).all({ ...bind, off: (page - 1) * 50 });
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sys_logininfor ${where}`).get(bind) as { n: number }).n;
  return ok({ rows, total, page });
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:logininfor:remove'); if (forbidden) return forbidden;
  if (new URL(req.url).searchParams.get('all') === '1') {
    db.prepare('DELETE FROM sys_logininfor').run();
    return ok({ cleared: true });
  }
  return ok({ error: '缺少 all=1' });
}
