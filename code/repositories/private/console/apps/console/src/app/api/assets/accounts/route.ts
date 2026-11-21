import { NextResponse } from "next/server";
import { z } from "zod";
import { queryAccounts, deleteAccounts } from "@/server/assets/store";
import { readJson, jsonError } from "@/server/assets/api-utils";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const num = (key: string) => {
    const v = q.get(key);
    return v !== null && v !== "" ? Number(v) : undefined;
  };
  return NextResponse.json(
    queryAccounts({
      batchId: num("batchId"),
      status: q.get("status") || undefined,
      email: q.get("email") || undefined,
      expiringWithinDays: num("expiring"),
      limit: num("limit") ?? 500,
      offset: num("offset") ?? 0,
    }),
  );
}

export async function DELETE(req: Request) {
  const schema = z.object({ ids: z.array(z.number().int().positive()).min(1) });
  const body = schema.safeParse(await readJson(req));
  if (!body.success) return jsonError("请选择要删除的账号");
  return NextResponse.json({ deleted: deleteAccounts(body.data.ids) });
}
