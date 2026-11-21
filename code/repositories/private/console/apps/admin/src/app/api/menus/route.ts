import { db } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:menu:list'); if (forbidden) return forbidden;
  return ok({ rows: db.prepare('SELECT * FROM sys_menu ORDER BY parent_id, order_num').all() });
}

export async function POST(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:menu:add'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { menuName?: string; parentId?: number; orderNum?: number; path?: string; menuType?: string; perms?: string };
  if (!b.menuName?.trim() || !b.menuType) return bad('菜单名称与类型不能为空');
  if (!['M', 'C', 'F'].includes(b.menuType)) return bad('类型仅限 M目录/C菜单/F按钮');
  const id = db.prepare(
    "INSERT INTO sys_menu (menu_name, parent_id, order_num, path, menu_type, perms, create_time) VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))",
  ).run(b.menuName.trim(), b.parentId ?? 0, b.orderNum ?? 0, b.path ?? '', b.menuType, b.perms ?? '');
  logOper(req, '菜单管理', 1, `新增 ${b.menuName}`);
  return ok({ id: Number(id.lastInsertRowid) });
}

export async function PUT(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:menu:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { menuId?: number; menuName?: string; parentId?: number; orderNum?: number; path?: string; menuType?: string; perms?: string };
  if (!b.menuId) return bad('缺少 menuId');
  if (b.menuId === b.parentId) return bad('上级菜单不能是自己');
  db.prepare(
    "UPDATE sys_menu SET menu_name = COALESCE(?, menu_name), parent_id = COALESCE(?, parent_id), order_num = COALESCE(?, order_num), path = COALESCE(?, path), menu_type = COALESCE(?, menu_type), perms = COALESCE(?, perms) WHERE menu_id = ?",
  ).run(b.menuName ?? null, b.parentId ?? null, b.orderNum ?? null, b.path ?? null, b.menuType ?? null, b.perms ?? null, b.menuId);
  logOper(req, '菜单管理', 2, `修改菜单 ${b.menuId}`);
  return ok();
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:menu:remove'); if (forbidden) return forbidden;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return bad('缺少 id');
  const child = db.prepare('SELECT COUNT(*) AS n FROM sys_menu WHERE parent_id = ?').get(id) as { n: number };
  if (child.n > 0) return bad(`存在 ${child.n} 个子菜单，禁止删除`);
  db.prepare('DELETE FROM sys_menu WHERE menu_id = ?').run(id);
  db.prepare('DELETE FROM sys_role_menu WHERE menu_id = ?').run(id);
  logOper(req, '菜单管理', 3, `删除菜单 ${id}`);
  return ok();
}
