import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getDataDir } from "@/server/assets/db";
import { jsonError, param } from "@/server/assets/api-utils";

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const file = (await param(ctx, "file")).replace(/[^\w.-]/g, "");
  const fp = path.join(getDataDir(), "exports", file);
  if (!fs.existsSync(fp)) return jsonError("文件不存在", 404);
  return new Response(fs.readFileSync(fp), {
    headers: {
      "Content-Type": "application/x-tar",
      "Content-Disposition": `attachment; filename="${file}"`,
    },
  });
}
