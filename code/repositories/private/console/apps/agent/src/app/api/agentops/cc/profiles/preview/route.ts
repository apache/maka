import { NextResponse } from "next/server";
import { z } from "zod";
import { mergeProfilePreview } from "@/server/agentops/cc/settings";
import { readJson } from "@/server/api-utils";

// 命令 17 merge_profile_preview（dry-run）
const schema = z.object({ profileName: z.string().min(1) });

export async function POST(req: Request) {
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "参数不合法" }, { status: 400 });
  }
  try {
    const preview = await mergeProfilePreview(body.data.profileName);
    return NextResponse.json({ preview });
  } catch (e) {
    return NextResponse.json(
      { code: "MERGE_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
