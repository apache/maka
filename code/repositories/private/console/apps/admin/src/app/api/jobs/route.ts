import { db } from '@/server/db';
import { bad, guard, logOper, ok } from '@/server/api-utils';
import { reloadScheduler, schedulerInfo, TARGETS } from '@/server/scheduler';
import { denyUnless } from '@/server/rbac';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'monitor:job:list'); if (forbidden) return forbidden;
  return ok({ rows: db.prepare('SELECT * FROM sys_job ORDER BY job_id').all(), targets: Object.keys(TARGETS), scheduler: schedulerInfo() });
}

export async function POST(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'monitor:job:add'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { jobName?: string; invokeTarget?: string; cronExpression?: string; remark?: string };
  if (!b.jobName?.trim() || !b.invokeTarget?.trim()) return bad('任务名称与调用目标不能为空');
  db.prepare("INSERT INTO sys_job (job_name, job_group, invoke_target, cron_expression, status, create_time, remark) VALUES (?, 'DEFAULT', ?, ?, '0', datetime('now','localtime'), ?)")
    .run(b.jobName.trim(), b.invokeTarget.trim(), b.cronExpression ?? '', b.remark ?? null);
  logOper(req, '定时任务', 1, `新增 ${b.jobName}`);
  reloadScheduler();
  return ok();
}

export async function PUT(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'monitor:job:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { jobId?: number; jobName?: string; status?: string; cronExpression?: string };
  if (!b.jobId) return bad('缺少 jobId');
  db.prepare("UPDATE sys_job SET job_name = COALESCE(?, job_name), status = COALESCE(?, status), cron_expression = COALESCE(?, cron_expression) WHERE job_id = ?")
    .run(b.jobName ?? null, b.status ?? null, b.cronExpression ?? null, b.jobId);
  logOper(req, '定时任务', 2, `修改任务 ${b.jobId}`);
  reloadScheduler();
  return ok();
}

export async function DELETE(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'monitor:job:remove'); if (forbidden) return forbidden;
  const id = Number(new URL(req.url).searchParams.get('id'));
  if (!id) return bad('缺少 id');
  db.prepare('DELETE FROM sys_job WHERE job_id = ?').run(id);
  logOper(req, '定时任务', 3, `删除任务 ${id}`);
  reloadScheduler();
  return ok();
}
