import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getAccount,
  accountHistory,
  deleteAccounts,
  setQuota,
  setStatus,
} from "@/server/assets/store";
import { ACCOUNT_STATUSES, type AccountRow } from "@ggbdpq/console-shared";
import { readJson, jsonError, param } from "@/server/assets/api-utils";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number(await param(ctx, "id"));
  const acc = getAccount(id);
  if (!acc) return jsonError("账号不存在", 404);
  return NextResponse.json({ account: acc, history: accountHistory(acc.id) });
}

const patchSchema = z.object({
  quota_percent: z.number().int().min(0).max(100).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  reason: z.string().optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number(await param(ctx, "id"));
  const body = patchSchema.safeParse(await readJson(req));
  if (!body.success) return jsonError("参数不合法");
  let acc: AccountRow | null | undefined = getAccount(id);
  if (!acc) return jsonError("账号不存在", 404);
  if (body.data.quota_percent !== undefined) {
    acc = setQuota(id, body.data.quota_percent, body.data.reason);
  }
  if (body.data.status) {
    acc = setStatus(id, body.data.status, body.data.reason);
  }
  return NextResponse.json(acc);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const id = Number(await param(ctx, "id"));
  const deleted = deleteAccounts([id]);
  if (deleted === 0) return jsonError("账号不存在", 404);
  return NextResponse.json({ deleted });
}
