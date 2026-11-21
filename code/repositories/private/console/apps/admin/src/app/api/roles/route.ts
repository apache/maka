import { db } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:role:list'); if (forbidden) return forbidden;
  const rows = db.prepare(
    `SELECT r.*, (SELECT COUNT(*) FROM sys_user_role ur WHERE ur.role_id = r.role_id) AS user_count
     FROM sys_role r WHERE r.del_flag = '0' ORDER BY r.role_sort`,
  ).all();
  return ok({ rows });
}

export async function POST(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:role:add'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { roleName?: string; roleKey?: string; roleSort?: number; remark?: string };
  if (!b.roleName?.trim() || !b.roleKey?.trim()) return bad('角色名称与权限字符不能为空');
  if (db.prepare("SELECT 1 FROM sys_role WHERE role_key = ? AND del_flag = '0'").get(b.roleKey)) return bad('权限字符已存在');
  db.prepare(
    "INSERT INTO sys_role (role_name, role_key, role_sort, status, create_time, remark) VALUES (?, ?, ?, '0', datetime('now','localtime'), ?)",
  ).run(b.roleName.trim(), b.roleKey.trim(), b.roleSort ?? 0, b.remark ?? null);
  logOper(req, '角色管理', 1, `新增 ${b.roleName}`);
  return ok();
}

export async function PUT(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:role:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { roleId?: number; roleName?: string; roleKey?: string; roleSort?: number; status?: string; remark?: string };
  if (!b.roleId) return bad('缺少 roleId');
  if (b.roleId === 1) return bad('内置超级管理员不允许修改');
  if (b.roleKey && db.prepare("SELECT 1 FROM sys_role WHERE role_key = ? AND role_id != ? AND del_flag = '0'").get(b.roleKey, b.roleId)) return bad('权限字符已存在');
  db.prepare(
    "UPDATE sys_role SET role_name = COALESCE(?, role_name), role_key = COALESCE(?, role_key), role_sort = COALESCE(?, role_sort), status = COALESCE(?, status), remark = COALESCE(?, remark) WHERE role_id = ?",
  ).run(b.roleName ?? null, b.roleKey ?? null, b.roleSort ?? null, b.status ?? null, b.remark ?? null, b.roleId);
  logOper(req, '角色管理', 2, `修改角色 ${b.roleId}`);
  return ok();
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:role:remove'); if (forbidden) return forbidden;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return bad('缺少 id');
  if (id === 1) return bad('内置超级管理员不允许删除');
  const used = db.prepare('SELECT COUNT(*) AS n FROM sys_user_role WHERE role_id = ?').get(id) as { n: number };
  if (used.n > 0) return bad(`该角色已分配给 ${used.n} 个用户，禁止删除`);
  db.prepare("UPDATE sys_role SET del_flag = '2' WHERE role_id = ?").run(id);
  db.prepare('DELETE FROM sys_role_menu WHERE role_id = ?').run(id);
  logOper(req, '角色管理', 3, `删除角色 ${id}`);
  return ok();
}
