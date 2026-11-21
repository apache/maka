import { NextResponse } from "next/server";
import { z } from "zod";
import { applyProfile } from "@/server/agentops/cc/settings";
import { readJson } from "@/server/api-utils";

// 命令 18 apply_profile
const schema = z.object({ profileName: z.string().min(1) });

export async function POST(req: Request) {
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "参数不合法" }, { status: 400 });
  }
  try {
    const hash = await applyProfile(body.data.profileName);
    return NextResponse.json({ hash });
  } catch (e) {
    return NextResponse.json(
      { code: "APPLY_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
