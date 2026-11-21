import { NextResponse } from "next/server";
import { getAgentopsRuntime } from "@/server/agentops/runtime";

export async function GET() {
  return NextResponse.json({ profiles: getAgentopsRuntime().listProfiles() });
}
