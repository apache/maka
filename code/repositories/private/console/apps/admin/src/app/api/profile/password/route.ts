import { db, encryptPassword } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';
import { randomBytes } from 'node:crypto';

export const runtime = 'nodejs';

export async function PUT(req: Request) {
  const s = guard(req); if (s) return s;
  const { getSession } = require('@/server/auth') as typeof import('@/server/auth');
  const session = getSession(req)!;
  const b = (await req.json().catch(() => ({}))) as { oldPassword?: string; newPassword?: string };
  if (!b.oldPassword || !b.newPassword) return bad('旧密码与新密码不能为空');
  if (b.newPassword.length < 6) return bad('新密码至少 6 位');
  const user = db.prepare('SELECT login_name, password, salt FROM sys_user WHERE user_id = ?').get(session.userId) as
    | { login_name: string; password: string; salt: string }
    | undefined;
  if (!user) return bad('用户不存在', 404);
  if (encryptPassword(user.login_name, b.oldPassword, user.salt) !== user.password) return bad('旧密码错误');
  const salt = randomBytes(4).toString('hex');
  db.prepare('UPDATE sys_user SET password = ?, salt = ? WHERE user_id = ?')
    .run(encryptPassword(user.login_name, b.newPassword, salt), salt, session.userId);
  logOper(req, '个人中心', 2, '修改登录密码');
  return ok();
}
