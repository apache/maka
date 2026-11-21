import { NextResponse } from 'next/server';
import { destroySession } from '@/server/auth';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  destroySession(req);
  return NextResponse.json({ ok: true });
}
