import { NextResponse } from "next/server";
import { z } from "zod";
import { togglePlugin } from "@/server/agentops/cc/settings";
import { readJson } from "@/server/api-utils";

// 命令 2 toggle_plugin
const schema = z.object({ pluginId: z.string().min(1), enabled: z.boolean() });

export async function POST(req: Request) {
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "参数不合法" }, { status: 400 });
  }
  try {
    const hash = togglePlugin(body.data.pluginId, body.data.enabled);
    return NextResponse.json({ hash });
  } catch (e) {
    return NextResponse.json(
      { code: "WRITE_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
