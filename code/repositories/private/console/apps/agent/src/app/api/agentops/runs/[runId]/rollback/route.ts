import { NextResponse } from "next/server";
import { getAgentopsRuntime } from "@/server/agentops/runtime";
import { param } from "@/server/api-utils";

export async function POST(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const runId = await param(ctx, "runId");
  const executor = getAgentopsRuntime().createEngine();
  try {
    const result = await executor.rollback(runId);
    return NextResponse.json({ run: result.run, success: result.success }, { status: result.success ? 200 : 500 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ code: "ROLLBACK_ERROR", message }, { status: 500 });
  }
}
