import { newCaptcha } from '@/server/captcha';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(newCaptcha());
}
