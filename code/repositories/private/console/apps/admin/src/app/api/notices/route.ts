import { db } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:notice:list'); if (forbidden) return forbidden;
  // 正文 longblob：列表不拖正文，编辑先取详情（对齐 liliya）
  return ok({ rows: db.prepare('SELECT notice_id, notice_title, notice_type, status, create_time, remark FROM sys_notice ORDER BY notice_id DESC').all() });
}

export async function POST(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:notice:add'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { noticeTitle?: string; noticeType?: string; noticeContent?: string };
  if (!b.noticeTitle?.trim() || !b.noticeType) return bad('公告标题与类型不能为空');
  db.prepare("INSERT INTO sys_notice (notice_title, notice_type, notice_content, status, create_time) VALUES (?, ?, ?, '0', datetime('now','localtime'))")
    .run(b.noticeTitle.trim(), b.noticeType, b.noticeContent ?? '');
  logOper(req, '通知公告', 1, `新增 ${b.noticeTitle}`);
  return ok();
}

export async function PUT(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:notice:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { noticeId?: number; noticeTitle?: string; noticeType?: string; noticeContent?: string; status?: string };
  if (!b.noticeId) return bad('缺少 noticeId');
  db.prepare("UPDATE sys_notice SET notice_title = COALESCE(?, notice_title), notice_type = COALESCE(?, notice_type), notice_content = COALESCE(?, notice_content), status = COALESCE(?, status) WHERE notice_id = ?")
    .run(b.noticeTitle ?? null, b.noticeType ?? null, b.noticeContent ?? null, b.status ?? null, b.noticeId);
  logOper(req, '通知公告', 2, `修改公告 ${b.noticeId}`);
  return ok();
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:notice:remove'); if (forbidden) return forbidden;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return bad('缺少 id');
  db.prepare('DELETE FROM sys_notice WHERE notice_id = ?').run(id);
  logOper(req, '通知公告', 3, `删除公告 ${id}`);
  return ok();
}
