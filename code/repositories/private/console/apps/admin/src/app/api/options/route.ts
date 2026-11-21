import { db } from '@/server/db';
import { guard, ok } from '@/server/api-utils';

export const runtime = 'nodejs';

/** 下拉数据：部门/角色/岗位（对齐 Go 版 options 组）。 */
export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const depts = db.prepare("SELECT dept_id AS value, dept_name AS label FROM sys_dept WHERE del_flag = '0' ORDER BY parent_id, order_num").all();
  const roles = db.prepare("SELECT role_id AS value, role_name AS label FROM sys_role WHERE del_flag = '0' AND status = '0' ORDER BY role_sort").all();
  const posts = db.prepare("SELECT post_id AS value, post_name AS label FROM sys_post WHERE status = '0' ORDER BY post_sort").all();
  const dicts = db.prepare('SELECT dict_type AS value, dict_name AS label FROM sys_dict_type ORDER BY dict_id').all();
  return ok({ depts, roles, posts, dicts });
}
