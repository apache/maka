import { db } from '@/server/db';
import { bad, guard, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

/** 全菜单树（DFS 展平）+ 指定角色已勾选 menuIds（回显）。 */
export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:role:list'); if (forbidden) return forbidden;
  const roleId = Number(new URL(req.url).searchParams.get('roleId') ?? 0);
  const all = db.prepare('SELECT menu_id, menu_name, parent_id, menu_type, perms FROM sys_menu ORDER BY parent_id, order_num, menu_id').all() as Array<Record<string, unknown>>;
  const byParent = new Map<number, typeof all>();
  for (const m of all) {
    const k = Number(m.parent_id);
    (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(m);
  }
  const flat: Array<Record<string, unknown> & { depth: number }> = [];
  const dfs = (parent: number, depth: number) => {
    for (const m of byParent.get(parent) ?? []) {
      flat.push({ ...m, depth });
      dfs(Number(m.menu_id), depth + 1);
    }
  };
  dfs(0, 0);
  const menuIds = roleId
    ? (db.prepare('SELECT menu_id FROM sys_role_menu WHERE role_id = ?').all(roleId) as Array<{ menu_id: number }>).map((r) => r.menu_id)
    : [];
  return ok({ rows: flat, menuIds });
}
