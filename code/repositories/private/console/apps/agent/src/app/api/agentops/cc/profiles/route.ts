import { NextResponse } from "next/server";
import { listProfiles } from "@/server/agentops/cc/settings";

// 命令 16 list_profiles
export async function GET() {
  return NextResponse.json({ profiles: listProfiles() });
}
