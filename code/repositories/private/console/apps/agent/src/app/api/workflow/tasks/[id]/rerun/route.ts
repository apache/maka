import { NextResponse } from "next/server";
import * as exec from "@/server/workflow/execution";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return NextResponse.json({ execution: exec.rerun(id) }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { code: "RERUN_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
