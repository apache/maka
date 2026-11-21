import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson, jsonError } from "@/server/assets/api-utils";
import { refreshOneAccountQuota } from "@/app/api/assets/accounts/[id]/quota/refresh/route";

export async function POST(req: Request) {
  const schema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) });
  const body = schema.safeParse(await readJson(req));
  if (!body.success) return jsonError("请选择要刷新真实额度的账号");
  const results = [];
  for (const id of body.data.ids) {
    results.push(await refreshOneAccountQuota(id));
  }
  return NextResponse.json({
    refreshed: results.filter((r) => r.account && !r.error).length,
    failed: results.filter((r) => r.error).length,
    results,
  });
}
