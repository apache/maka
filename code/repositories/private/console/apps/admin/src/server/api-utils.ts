/** API 公共件：鉴权守卫、操作日志、错误响应。 */
import { NextResponse } from 'next/server';
import { db } from '@/server/db';
import { getSession } from '@/server/auth';

/** 鉴权守卫：已登录返回 null（放行），否则返回 401 响应。 */
export function guard(req: Request): NextResponse | null {
  return getSession(req) ? null : NextResponse.json({ error: '未登录或会话过期' }, { status: 401 });
}

/** 写操作日志（对齐 liliya sys_oper_log：参数脱敏 password）。 */
export function logOper(req: Request, title: string, businessType: number, detail?: string, costMs = 0) {
  let operParam: string | null = null;
  try {
    const u = new URL(req.url);
    operParam = u.search ? u.search.slice(0, 500) : null;
  } catch { /* 忽略 */ }
  db.prepare(
    `INSERT INTO sys_oper_log (title, business_type, method, request_method, oper_name, oper_url, oper_ip, oper_param, json_result, status, error_msg, oper_time, cost_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, datetime('now','localtime'), ?)`,
  ).run(
    title, businessType, detail ?? '', req.method,
    getSession(req)?.loginName ?? '', u(req), req.headers.get('x-forwarded-for') ?? 'local',
    operParam, detail ? `{"detail":"${detail.replace(/"/g, '')}"}` : null, costMs,
  );
  function u(r: Request) { try { return new URL(r.url).pathname; } catch { return ''; } }
}

export const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });
export const ok = (data: object = { ok: true }) => NextResponse.json(data);
