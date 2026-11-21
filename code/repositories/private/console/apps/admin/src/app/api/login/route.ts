import { NextResponse } from 'next/server';
import { db } from '@/server/db';
import { encryptPassword } from '@/server/db';
import { createSession } from '@/server/auth';
import { verifyCaptcha } from '@/server/captcha';
import { permsOf } from '@/server/rbac';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { loginName?: string; password?: string; captchaId?: string; captchaCode?: string } | null;
  const loginName = body?.loginName?.trim();
  const password = body?.password ?? '';
  if (!loginName || !password) {
    return NextResponse.json({ error: '账号和密码不能为空' }, { status: 400 });
  }
  if (!verifyCaptcha(body?.captchaId, body?.captchaCode)) {
    return NextResponse.json({ error: '验证码错误或已过期' }, { status: 401 });
  }
  const user = db.prepare(
    "SELECT user_id, login_name, user_name, password, salt, status, del_flag FROM sys_user WHERE login_name = ? AND del_flag = '0'",
  ).get(loginName) as
    | { user_id: number; login_name: string; user_name: string; password: string; salt: string; status: string }
    | undefined;
  const failed = (msg: string) => {
    db.prepare("INSERT INTO sys_logininfor (user_name, ipaddr, status, msg, login_time) VALUES (?, ?, '1', ?, datetime('now','localtime'))")
      .run(loginName, req.headers.get('x-forwarded-for') ?? 'local', msg);
    return NextResponse.json({ error: msg }, { status: 401 });
  };
  if (!user) return failed('账号不存在');
  if (user.status !== '0') return failed('账号已停用');
  if (encryptPassword(loginName, password, user.salt) !== user.password) return failed('密码错误');
  db.prepare("INSERT INTO sys_logininfor (user_name, ipaddr, status, msg, login_time) VALUES (?, ?, '0', '登录成功', datetime('now','localtime'))")
    .run(loginName, req.headers.get('x-forwarded-for') ?? 'local');
  const token = createSession(user.user_id, user.login_name, user.user_name);
  const perms = user.user_id === 1 ? ['*'] : [...permsOf(user.user_id)];
  return NextResponse.json({ token, user: { userId: user.user_id, loginName: user.login_name, userName: user.user_name }, perms });
}
