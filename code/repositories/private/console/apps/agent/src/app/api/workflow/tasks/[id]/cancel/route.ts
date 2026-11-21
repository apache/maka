import { NextResponse } from "next/server";
import * as exec from "@/server/workflow/execution";
import { readJson } from "@/server/api-utils";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await readJson(req)) as { executionId?: string };
  try {
    return NextResponse.json({ execution: exec.cancel(id, body.executionId) });
  } catch (e) {
    return NextResponse.json(
      { code: "CANCEL_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
