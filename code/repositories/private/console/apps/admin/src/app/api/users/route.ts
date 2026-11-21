import { db, encryptPassword } from '@/server/db';
import { bad, logOper, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';
import { getSession } from '@/server/auth';
import { randomBytes } from 'node:crypto';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const session = getSession(req);
  if (!session) return bad('未登录或会话过期', 401);
  const forbidden = denyUnless(req, 'system:user:list'); if (forbidden) return forbidden;
  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
  const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') ?? 10)));
  const q = url.searchParams.get('q')?.trim();
  const where = q ? "WHERE del_flag = '0' AND (login_name LIKE @q OR user_name LIKE @q)" : "WHERE del_flag = '0'";
  const bind: Record<string, string> = q ? { q: `%${q}%` } : {};
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sys_user ${where}`).get(bind) as { n: number }).n;
  const rows = db.prepare(
    `SELECT user_id, dept_id, login_name, user_name, user_type, email, phonenumber, sex, status, create_time, login_ip, login_date
     FROM sys_user ${where} ORDER BY user_id LIMIT @size OFFSET @off`,
  ).all({ ...bind, size, off: (page - 1) * size });
  return ok({ total, page, size, rows });
}

/** 新增：服务端加盐加密（对齐 liliya）。 */
export async function POST(req: Request) {
  const session = getSession(req);
  if (!session) return bad('未登录或会话过期', 401);
  const forbidden = denyUnless(req, 'system:user:add'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { loginName?: string; userName?: string; password?: string; deptId?: number };
  if (!b.loginName?.trim() || !b.userName?.trim() || !b.password) return bad('账号、昵称与密码不能为空');
  if (db.prepare("SELECT 1 FROM sys_user WHERE login_name = ? AND del_flag = '0'").get(b.loginName)) return bad('账号已存在');
  const salt = randomBytes(4).toString('hex');
  db.prepare(
    "INSERT INTO sys_user (dept_id, login_name, user_name, password, salt, status, create_time) VALUES (?, ?, ?, ?, ?, '0', datetime('now','localtime'))",
  ).run(b.deptId ?? 100, b.loginName.trim(), b.userName.trim(), encryptPassword(b.loginName.trim(), b.password, salt), salt);
  logOper(req, '用户管理', 1, `新增 ${b.loginName}`);
  return ok();
}

/** 编辑 / 重置密码（password 字段出现即重置）。 */
export async function PUT(req: Request) {
  const session = getSession(req);
  if (!session) return bad('未登录或会话过期', 401);
  const forbidden = denyUnless(req, 'system:user:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { userId?: number; userName?: string; status?: string; password?: string };
  if (!b.userId) return bad('缺少 userId');
  if (b.userId === 1 && (b.status === '1' || b.password)) return bad('内置管理员禁止停用或重置密码');
  if (b.password) {
    const user = db.prepare('SELECT login_name FROM sys_user WHERE user_id = ?').get(b.userId) as { login_name: string };
    const salt = randomBytes(4).toString('hex');
    db.prepare('UPDATE sys_user SET password = ?, salt = ? WHERE user_id = ?')
      .run(encryptPassword(user.login_name, b.password, salt), salt, b.userId);
  } else {
    db.prepare('UPDATE sys_user SET user_name = COALESCE(?, user_name), status = COALESCE(?, status) WHERE user_id = ?')
      .run(b.userName ?? null, b.status ?? null, b.userId);
  }
  logOper(req, '用户管理', b.password ? 2 : 2, b.password ? `重置密码 ${b.userId}` : `修改用户 ${b.userId}`);
    return ok();
}

/** 批量软删（禁删 admin、禁自删）。 */
export async function DELETE(req: Request) {
  const session = getSession(req);
  if (!session) return bad('未登录或会话过期', 401);
  const forbidden = denyUnless(req, 'system:user:remove'); if (forbidden) return forbidden;
  const ids = (new URL(req.url).searchParams.get('ids') ?? '').split(',').map(Number).filter(Boolean);
  if (!ids.length) return bad('缺少 ids');
  if (ids.includes(1)) return bad('内置管理员禁止删除');
  if (session && ids.includes(session.userId)) return bad('不能删除自己');
  const del = db.prepare("UPDATE sys_user SET del_flag = '2' WHERE user_id = ?");
  for (const id of ids) del.run(id);
  logOper(req, '用户管理', 3, `批量软删 ${ids.join(',')}`);
  return ok();
}
