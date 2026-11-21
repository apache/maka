import { NextResponse } from "next/server";
import { z } from "zod";
import { importPresets } from "@/server/agentops/cc/settings";
import { readJson } from "@/server/api-utils";

// 命令 15 import_presets（原命令收 json_data 字符串）
const schema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    icon: z.string().optional(),
    description: z.string().optional(),
    enabledPlugins: z.record(z.string(), z.boolean()),
  }),
);

export async function POST(req: Request) {
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "预设格式不合法" }, { status: 400 });
  }
  return NextResponse.json({ presets: importPresets(JSON.stringify(body.data)) });
}
