import { NextResponse } from "next/server";
import { getWorkflowDb } from "@/server/workflow/db";

// 审计日志查询（倒序）
export async function GET(req: Request) {
  const limit = Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 50));
  const rows = getWorkflowDb()
    .prepare("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return NextResponse.json({
    entries: rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      action: r.action,
      resource: r.resource,
      details: r.details ? JSON.parse(r.details as string) : null,
    })),
  });
}
