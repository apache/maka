import { db } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

/** DFS 展平（depth 缩进渲染），对齐 liliya 部门管理形态。 */
export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:dept:list'); if (forbidden) return forbidden;
  const all = db.prepare("SELECT * FROM sys_dept WHERE del_flag = '0' ORDER BY parent_id, order_num").all() as Array<Record<string, unknown>>;
  const byParent = new Map<number, typeof all>();
  for (const d of all) {
    const k = Number(d.parent_id);
    (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(d);
  }
  const flat: Array<Record<string, unknown> & { depth: number }> = [];
  const dfs = (parent: number, depth: number) => {
    for (const d of byParent.get(parent) ?? []) {
      flat.push({ ...d, depth });
      dfs(Number(d.dept_id), depth + 1);
    }
  };
  dfs(0, 0);
  return ok({ rows: flat });
}

export async function POST(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:dept:add'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { deptName?: string; parentId?: number; orderNum?: number };
  if (!b.deptName?.trim()) return bad('部门名称不能为空');
  const parentId = b.parentId ?? 100;
  const parent = db.prepare('SELECT ancestors FROM sys_dept WHERE dept_id = ?').get(parentId) as { ancestors: string } | undefined;
  if (!parent) return bad('上级部门不存在');
  const id = db.prepare(
    "INSERT INTO sys_dept (parent_id, ancestors, dept_name, order_num, create_time) VALUES (?, ?, ?, ?, datetime('now','localtime'))",
  ).run(parentId, `${parent.ancestors},${parentId}`.replace(/^,/, ''), b.deptName.trim(), b.orderNum ?? 0);
  logOper(req, '部门管理', 1, `新增 ${b.deptName}`);
  return ok({ id: Number(id.lastInsertRowid) });
}

export async function PUT(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:dept:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { deptId?: number; deptName?: string; parentId?: number; orderNum?: number };
  if (!b.deptId) return bad('缺少 deptId');
  if (b.deptId === b.parentId) return bad('上级部门不能是自己');
  if (b.deptId === 100) return bad('根部门不允许修改上级');
  db.prepare(
    "UPDATE sys_dept SET dept_name = COALESCE(?, dept_name), parent_id = COALESCE(?, parent_id), order_num = COALESCE(?, order_num) WHERE dept_id = ?",
  ).run(b.deptName ?? null, b.parentId ?? null, b.orderNum ?? null, b.deptId);
  logOper(req, '部门管理', 2, `修改部门 ${b.deptId}`);
  return ok();
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:dept:remove'); if (forbidden) return forbidden;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return bad('缺少 id');
  if (id === 100) return bad('根部门禁止删除');
  const child = db.prepare("SELECT COUNT(*) AS n FROM sys_dept WHERE parent_id = ? AND del_flag = '0'").get(id) as { n: number };
  if (child.n > 0) return bad(`存在 ${child.n} 个子部门，禁止删除（对齐 liliya：孙级不级联为显式简化）`);
  const users = db.prepare("SELECT COUNT(*) AS n FROM sys_user WHERE dept_id = ? AND del_flag = '0'").get(id) as { n: number };
  if (users.n > 0) return bad(`部门下有 ${users.n} 个用户，禁止删除`);
  db.prepare("UPDATE sys_dept SET del_flag = '2' WHERE dept_id = ?").run(id);
  logOper(req, '部门管理', 3, `删除部门 ${id}`);
  return ok();
}
