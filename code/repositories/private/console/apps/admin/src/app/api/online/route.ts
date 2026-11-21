import { listSessions, killSession } from '@/server/auth';
import { guard, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'monitor:online:list'); if (forbidden) return forbidden;
  return ok({ rows: listSessions() });
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'monitor:online:forceLogout'); if (forbidden) return forbidden;
  const token = new URL(req.url).searchParams.get('token');
  if (!token) return NextResponse.json({ error: '缺少 token' }, { status: 400 });
  return ok({ killed: killSession(token) });
}
