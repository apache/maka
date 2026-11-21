import { NextResponse } from "next/server";
import { z } from "zod";
import { batchUpdatePlugins } from "@/server/agentops/cc/settings";
import { readJson } from "@/server/api-utils";

// 命令 3 batch_update_plugins
const schema = z.object({ updates: z.record(z.string(), z.boolean()) });

export async function POST(req: Request) {
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "参数不合法" }, { status: 400 });
  }
  try {
    return NextResponse.json({ hash: batchUpdatePlugins(body.data.updates) });
  } catch (e) {
    return NextResponse.json(
      { code: "WRITE_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
