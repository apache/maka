import { db } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';

export const runtime = 'nodejs';

/** 个人中心：只操作当前会话用户（user_id 取会话，不接受参数）。 */
export async function GET(req: Request) {
  const s = guard(req); if (s) return s;
  const session = getSessionUser(req);
  const row = db.prepare(
    'SELECT user_id, login_name, user_name, email, phonenumber, sex, create_time, remark FROM sys_user WHERE user_id = ?',
  ).get(session.userId) as Record<string, unknown> | undefined;
  if (!row) return bad('用户不存在', 404);
  return ok({ row });
}

export async function PUT(req: Request) {
  const s = guard(req); if (s) return s;
  const session = getSessionUser(req);
  const b = (await req.json().catch(() => ({}))) as { userName?: string; email?: string; phonenumber?: string };
  if (b.userName != null && !b.userName.trim()) return bad('昵称不能为空');
  db.prepare('UPDATE sys_user SET user_name = COALESCE(?, user_name), email = COALESCE(?, email), phonenumber = COALESCE(?, phonenumber) WHERE user_id = ?')
    .run(b.userName ?? null, b.email ?? null, b.phonenumber ?? null, session.userId);
  logOper(req, '个人中心', 2, '修改个人资料');
  return ok();
}

function getSessionUser(req: Request) {
  // guard 已放行，会话必存在
  const { getSession } = require('@/server/auth') as typeof import('@/server/auth');
  return getSession(req)!;
}
