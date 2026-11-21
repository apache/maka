import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getDataRoot } from "@/server/agentops/cc/settings";

// 命令 5 list_backups
export async function GET() {
  const backupDir = path.join(getDataRoot(), "backups");
  if (!fs.existsSync(backupDir)) return NextResponse.json({ backups: [] });
  const backups = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith("settings.json.bak-"))
    .sort()
    .reverse()
    .map((f) => {
      const fp = path.join(backupDir, f);
      const stat = fs.statSync(fp);
      return { path: fp, createdAt: stat.mtime.toISOString(), size: stat.size };
    });
  return NextResponse.json({ backups });
}
