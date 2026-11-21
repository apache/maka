import { NextResponse } from "next/server";
import { readSettings } from "@/server/agentops/cc/settings";
import { getCcSettingsVersion } from "@/server/agentops/cc/watch";

// 前端 watcher 轮询端点：版本号 + 当前 hash
export async function GET() {
  let hash = "";
  try {
    hash = readSettings().hash;
  } catch {
    hash = "";
  }
  return NextResponse.json({ version: getCcSettingsVersion(), hash });
}
