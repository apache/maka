import { NextResponse } from "next/server";
import { z } from "zod";
import { applyPreset } from "@/server/agentops/cc/settings";
import { readJson } from "@/server/api-utils";

// 命令 4 apply_preset
const schema = z.object({
  presetPlugins: z.record(z.string(), z.boolean()),
  presetName: z.string().min(1),
});

export async function POST(req: Request) {
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "参数不合法" }, { status: 400 });
  }
  try {
    return NextResponse.json({ hash: applyPreset(body.data.presetPlugins, body.data.presetName) });
  } catch (e) {
    return NextResponse.json(
      { code: "WRITE_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
