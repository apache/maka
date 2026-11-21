import { db } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:dict:list'); if (forbidden) return forbidden;
  const dictType = new URL(req.url).searchParams.get('dictType');
  if (dictType) return ok({ rows: db.prepare('SELECT * FROM sys_dict_data WHERE dict_type = ? ORDER BY dict_sort').all(dictType) });
  return ok({ rows: db.prepare('SELECT * FROM sys_dict_type ORDER BY dict_id').all() });
}

export async function POST(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:dict:add'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { dictName?: string; dictType?: string; dictLabel?: string; dictValue?: string; remark?: string };
  if (b.dictName && b.dictType) {
    if (db.prepare('SELECT 1 FROM sys_dict_type WHERE dict_type = ?').get(b.dictType)) return bad('字典类型已存在');
    db.prepare("INSERT INTO sys_dict_type (dict_name, dict_type, status, create_time, remark) VALUES (?, ?, '0', datetime('now','localtime'), ?)")
      .run(b.dictName.trim(), b.dictType.trim(), b.remark ?? null);
    logOper(req, '字典管理', 1, `新增类型 ${b.dictType}`);
    return ok();
  }
  if (b.dictType && b.dictLabel && b.dictValue) {
    db.prepare("INSERT INTO sys_dict_data (dict_sort, dict_label, dict_value, dict_type, status, create_time) VALUES (0, ?, ?, ?, '0', datetime('now','localtime'))")
      .run(b.dictLabel, b.dictValue, b.dictType);
    logOper(req, '字典管理', 1, `新增数据 ${b.dictLabel}`);
    return ok();
  }
  return bad('参数不全');
}

/** 字典数据编辑（dict_code 定位；仅标签/键值/排序/状态）。 */
export async function PUT(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:dict:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { dictCode?: number; dictLabel?: string; dictValue?: string; dictSort?: number; isDefault?: string };
  if (!b.dictCode) return bad('缺少 dictCode');
  db.prepare(
    "UPDATE sys_dict_data SET dict_label = COALESCE(?, dict_label), dict_value = COALESCE(?, dict_value), dict_sort = COALESCE(?, dict_sort), is_default = COALESCE(?, is_default) WHERE dict_code = ?",
  ).run(b.dictLabel ?? null, b.dictValue ?? null, b.dictSort ?? null, b.isDefault ?? null, b.dictCode);
  logOper(req, '字典管理', 2, `修改数据 ${b.dictCode}`);
  return ok();
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:dict:remove'); if (forbidden) return forbidden;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return bad('缺少 id');
  const type = db.prepare('SELECT dict_type FROM sys_dict_type WHERE dict_id = ?').get(id) as { dict_type: string } | undefined;
  if (!type) {
    // 非 dict_type id → 按 dict_data 兜底删除（前端数据表删除走此分支）
    const data = db.prepare('SELECT dict_type FROM sys_dict_data WHERE dict_code = ?').get(id) as { dict_type: string } | undefined;
    if (!data) return bad('id 既不是字典类型也不是字典数据');
    db.prepare('DELETE FROM sys_dict_data WHERE dict_code = ?').run(id);
    logOper(req, '字典管理', 3, `删除数据 dict_code=${id}`);
    return ok();
  }
  db.prepare('DELETE FROM sys_dict_data WHERE dict_type = ?').run(type.dict_type); // 类型改名/删除连带数据（对齐 liliya）
  db.prepare('DELETE FROM sys_dict_type WHERE dict_id = ?').run(id);
  logOper(req, '字典管理', 3, `删除类型 ${type.dict_type} 并连带清理数据`);
  return ok();
}
