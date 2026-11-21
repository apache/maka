import { NextResponse } from "next/server";
import { getAgentopsRuntime } from "@/server/agentops/runtime";

export async function GET() {
  const runStore = getAgentopsRuntime().createRunStore();
  const runs = await runStore.listRuns();
  return NextResponse.json({ runs });
}
