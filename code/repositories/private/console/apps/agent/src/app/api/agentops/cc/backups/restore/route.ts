import { NextResponse } from "next/server";
import { z } from "zod";
import { restoreBackup } from "@/server/agentops/cc/settings";
import { readJson } from "@/server/api-utils";

// 命令 6 restore_backup
const schema = z.object({ backupPath: z.string().min(1) });

export async function POST(req: Request) {
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "参数不合法" }, { status: 400 });
  }
  try {
    return NextResponse.json({ hash: restoreBackup(body.data.backupPath) });
  } catch (e) {
    return NextResponse.json(
      { code: "RESTORE_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
