import { NextResponse } from "next/server";
import { getAgentopsRuntime } from "@/server/agentops/runtime";
import { executeRun } from "@/server/agentops/execute";
import type { ExecuteRequest } from "@ggbdpq/console-shared";
import { readJson } from "@/server/api-utils";

export async function POST(req: Request) {
  const body = (await readJson(req)) as ExecuteRequest;
  const rt = getAgentopsRuntime();
  const executor = rt.createEngine();
  const result = await executeRun(body, "dry-run", rt, executor);
  return NextResponse.json(result, { status: result.success ? 200 : 500 });
}
