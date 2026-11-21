import { NextResponse } from "next/server";
import { listAccounts } from "@/server/register/db";

export async function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 200);
  return NextResponse.json({ accounts: listAccounts(Number.isFinite(limit) ? limit : 200) });
}
