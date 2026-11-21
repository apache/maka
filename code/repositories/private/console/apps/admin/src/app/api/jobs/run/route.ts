import { db } from '@/server/db';
import { bad, guard, ok } from '@/server/api-utils';
import { denyUnless } from '@/server/rbac';
import { runJobManual } from '@/server/scheduler';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const denied = guard(req); if (denied) return denied;
  const forbidden = denyUnless(req, 'monitor:job:edit'); if (forbidden) return forbidden;
  const b = (await req.json().catch(() => ({}))) as { jobId?: number };
  const job = db.prepare('SELECT * FROM sys_job WHERE job_id = ?').get(b?.jobId ?? 0) as
    | Parameters<typeof runJobManual>[0]
    | undefined;
  if (!job) return bad('任务不存在');
  const started = Date.now();
  const result = runJobManual(job);
  return ok({ ...result, wallMs: Date.now() - started });
}
