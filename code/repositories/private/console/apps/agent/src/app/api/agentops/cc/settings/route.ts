import { NextResponse } from "next/server";
import {
  readSettings,
  getSettingsPath,
  checkSettingsExists,
  getCurrentHash,
} from "@/server/agentops/cc/settings";

// 命令 1 read_settings + 7 get_default_settings_path + 8 check_settings_exists + 9 get_current_hash 聚合
export async function GET() {
  if (!checkSettingsExists()) {
    return NextResponse.json({ code: "FILE_NOT_FOUND", message: "配置文件不存在" }, { status: 404 });
  }
  const r = readSettings();
  return NextResponse.json({
    settings: r.settings,
    path: r.path,
    hash: r.hash,
    modifiedAt: r.modifiedAt,
    defaultPath: getSettingsPath(),
  });
}
