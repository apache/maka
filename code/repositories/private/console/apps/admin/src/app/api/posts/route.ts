import { db } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:post:list'); if (forbidden) return forbidden;
  return ok({ rows: db.prepare('SELECT * FROM sys_post ORDER BY post_sort').all() });
}

export async function POST(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:post:add'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { postCode?: string; postName?: string; postSort?: number };
  if (!b.postCode?.trim() || !b.postName?.trim()) return bad('岗位编码与名称不能为空');
  if (db.prepare('SELECT 1 FROM sys_post WHERE post_code = ?').get(b.postCode)) return bad('岗位编码已存在');
  if (db.prepare('SELECT 1 FROM sys_post WHERE post_name = ?').get(b.postName)) return bad('岗位名称已存在');
  db.prepare("INSERT INTO sys_post (post_code, post_name, post_sort, create_time) VALUES (?, ?, ?, datetime('now','localtime'))")
    .run(b.postCode.trim(), b.postName.trim(), b.postSort ?? 0);
  logOper(req, '岗位管理', 1, `新增 ${b.postName}`);
  return ok();
}

export async function PUT(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:post:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { postId?: number; postCode?: string; postName?: string; postSort?: number; status?: string };
  if (!b.postId) return bad('缺少 postId');
  if (b.postCode && db.prepare('SELECT 1 FROM sys_post WHERE post_code = ? AND post_id != ?').get(b.postCode, b.postId)) return bad('岗位编码已存在');
  db.prepare(
    "UPDATE sys_post SET post_code = COALESCE(?, post_code), post_name = COALESCE(?, post_name), post_sort = COALESCE(?, post_sort), status = COALESCE(?, status) WHERE post_id = ?",
  ).run(b.postCode ?? null, b.postName ?? null, b.postSort ?? null, b.status ?? null, b.postId);
  logOper(req, '岗位管理', 2, `修改岗位 ${b.postId}`);
  return ok();
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:post:remove'); if (forbidden) return forbidden;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return bad('缺少 id');
  const used = db.prepare('SELECT COUNT(*) AS n FROM sys_user_post WHERE post_id = ?').get(id) as { n: number };
  if (used.n > 0) return bad(`岗位已分配给 ${used.n} 个用户，禁止删除`);
  db.prepare('DELETE FROM sys_post WHERE post_id = ?').run(id);
  logOper(req, '岗位管理', 3, `删除岗位 ${id}`);
  return ok();
}
