import { NextResponse } from "next/server";
import { getRunDetail, listRuns } from "@/server/register/db";

/** ?runId=<id> 查询单次运行详情（含报告 JSON）；否则列最近运行。 */
export async function GET(req: Request) {
  const runId = new URL(req.url).searchParams.get("runId");
  if (runId) {
    const detail = getRunDetail(runId);
    if (!detail) return NextResponse.json({ code: "NOT_FOUND", message: "run 不存在" }, { status: 404 });
    return NextResponse.json({ run: detail });
  }
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  return NextResponse.json({ runs: listRuns(Number.isFinite(limit) ? limit : 50) });
}
