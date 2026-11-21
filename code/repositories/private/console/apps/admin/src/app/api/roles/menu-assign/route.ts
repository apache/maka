import { db } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';
import { denyUnless, invalidatePermCache } from '@/server/rbac';

export const runtime = 'nodejs';

/** 角色-菜单授权：全量替换 sys_role_menu（内置超管不参与——user_id=1 全通过语义独立于本表）。 */
export async function POST(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:role:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { roleId?: number; menuIds?: number[] };
  if (!b.roleId) return bad('缺少 roleId');
  if (b.roleId === 1) return bad('内置超级管理员无需分配（全通过语义）');
  const role = db.prepare("SELECT role_id FROM sys_role WHERE role_id = ? AND del_flag = '0'").get(b.roleId);
  if (!role) return bad('角色不存在');
  const ids = (b.menuIds ?? []).filter((n) => Number.isInteger(n));
  db.prepare('DELETE FROM sys_role_menu WHERE role_id = ?').run(b.roleId);
  const ins = db.prepare('INSERT OR IGNORE INTO sys_role_menu (role_id, menu_id) VALUES (?, ?)');
  for (const id of ids) ins.run(b.roleId, id);
  invalidatePermCache(); // 授权变更即时生效（清全部权限缓存，量级为个人台可忽略）
  logOper(req, '角色管理', 2, `分配权限 角色${b.roleId} 共${ids.length}项`);
  return ok({ count: ids.length });
}
