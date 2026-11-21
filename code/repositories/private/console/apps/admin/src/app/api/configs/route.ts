import { db } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:config:list'); if (forbidden) return forbidden;
  return ok({ rows: db.prepare('SELECT * FROM sys_config ORDER BY config_id').all() });
}

export async function POST(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:config:add'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { configName?: string; configKey?: string; configValue?: string; remark?: string };
  if (!b.configName?.trim() || !b.configKey?.trim()) return bad('参数名称与键名不能为空');
  if (db.prepare('SELECT 1 FROM sys_config WHERE config_key = ?').get(b.configKey)) return bad('参数键名已存在');
  db.prepare("INSERT INTO sys_config (config_name, config_key, config_value, config_type, create_time, remark) VALUES (?, ?, ?, 'N', datetime('now','localtime'), ?)")
    .run(b.configName.trim(), b.configKey.trim(), b.configValue ?? '', b.remark ?? null);
  logOper(req, '参数设置', 1, `新增 ${b.configKey}`);
  return ok();
}

export async function PUT(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:config:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { configId?: number; configName?: string; configValue?: string; remark?: string };
  if (!b.configId) return bad('缺少 configId');
  db.prepare("UPDATE sys_config SET config_name = COALESCE(?, config_name), config_value = COALESCE(?, config_value), remark = COALESCE(?, remark) WHERE config_id = ?")
    .run(b.configName ?? null, b.configValue ?? null, b.remark ?? null, b.configId);
  logOper(req, '参数设置', 2, `修改参数 ${b.configId}`);
  return ok();
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'system:config:remove'); if (forbidden) return forbidden;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return bad('缺少 id');
  const row = db.prepare('SELECT config_type, config_key FROM sys_config WHERE config_id = ?').get(id) as { config_type: string; config_key: string } | undefined;
  if (!row) return bad('参数不存在');
  if (row.config_type === 'Y') return bad('内置参数禁止删除');
  db.prepare('DELETE FROM sys_config WHERE config_id = ?').run(id);
  logOper(req, '参数设置', 3, `删除参数 ${row.config_key}`);
  return ok();
}
