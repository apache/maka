import { NextResponse } from "next/server";
import { getAgentopsRuntime } from "@/server/agentops/runtime";
import { param } from "@/server/api-utils";

export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const runId = await param(ctx, "runId");
  const runStore = getAgentopsRuntime().createRunStore();
  const run = await runStore.readRun(runId);
  if (!run) {
    return NextResponse.json({ code: "NOT_FOUND", message: `Run not found: ${runId}` }, { status: 404 });
  }
  return NextResponse.json({ run });
}
