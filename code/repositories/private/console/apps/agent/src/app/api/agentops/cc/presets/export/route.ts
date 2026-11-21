import { NextResponse } from "next/server";
import { z } from "zod";
import { exportPresets } from "@/server/agentops/cc/settings";
import { readJson } from "@/server/api-utils";

// 命令 14 export_presets
const schema = z.object({ presetIds: z.array(z.string()) });

export async function POST(req: Request) {
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "参数不合法" }, { status: 400 });
  }
  return new Response(exportPresets(body.data.presetIds), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": 'attachment; filename="cc-presets.json"',
    },
  });
}
