import { NextResponse } from "next/server";
import { queryAccounts } from "@/server/assets/store";
import { param } from "@/server/assets/api-utils";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const batchId = Number(await param(ctx, "id"));
  const q = new URL(req.url).searchParams;
  return NextResponse.json(
    queryAccounts({
      batchId,
      status: q.get("status") || undefined,
      email: q.get("email") || undefined,
      limit: 2000,
    }),
  );
}
