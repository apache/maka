/**
 * RBAC —— 端点级权限校验（对齐 Go 版 RequirePerm）。
 * user_id=1 全通过（存量 isAdmin 语义）；否则沿 用户→角色→role_menu→menu.perms 匹配。
 * 会话内缓存权限集：角色授权变更后旧会话到滑动续期为止仍持旧集（30 分钟内），
 * 与 Go 版内存形态一致；需要即时生效走在线用户强制下线。
 */
import { db } from '@/server/db';
import { getSession } from '@/server/auth';

const g = globalThis as typeof globalThis & { __adminPerms?: Map<number, Set<string>> };
const cache = (g.__adminPerms ??= new Map());

export function permsOf(userId: number): Set<string> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const rows = db.prepare(
    `SELECT DISTINCT m.perms FROM sys_user_role ur
     JOIN sys_role_menu rm ON rm.role_id = ur.role_id
     JOIN sys_menu m ON m.menu_id = rm.menu_id
     WHERE ur.user_id = ? AND m.perms != ''`,
  ).all(userId) as Array<{ perms: string }>;
  const set = new Set(rows.map((r) => r.perms));
  cache.set(userId, set);
  return set;
}

export function invalidatePermCache(userId?: number) {
  if (userId == null) cache.clear();
  else cache.delete(userId);
}

/** 已登录且持有 perm（或 isAdmin）→ 返回 null 放行；否则返回 403。未登录返回 401。 */
export function denyUnless(req: Request, perm: string): Response | null {
  const session = getSession(req);
  if (!session) {
    return new Response(JSON.stringify({ error: '未登录或会话过期' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  if (session.userId === 1) return null;
  if (!permsOf(session.userId).has(perm)) {
    return new Response(JSON.stringify({ error: `无操作权限：${perm}` }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }
  return null;
}
