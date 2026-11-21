import { NextResponse } from 'next/server';
import { getSession } from '@/server/auth';
import { permsOf } from '@/server/rbac';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const s = getSession(req);
  if (!s) return NextResponse.json({ error: '未登录或会话过期' }, { status: 401 });
  const perms = s.userId === 1 ? ['*'] : [...permsOf(s.userId)];
  return NextResponse.json({ user: s, perms });
}
