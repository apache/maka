import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readCustomPresets,
  saveCustomPreset,
  deleteCustomPreset,
} from "@/server/agentops/cc/settings";
import { readJson } from "@/server/api-utils";

// 命令 11 read_custom_presets / 12 save_custom_preset / 13 delete_custom_preset
const presetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  icon: z.string().optional(),
  description: z.string().optional(),
  enabledPlugins: z.record(z.string(), z.boolean()),
});

export async function GET() {
  return NextResponse.json({ presets: readCustomPresets() });
}

export async function POST(req: Request) {
  const body = presetSchema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "参数不合法" }, { status: 400 });
  }
  return NextResponse.json({ preset: saveCustomPreset(body.data) });
}

export async function DELETE(req: Request) {
  const schema = z.object({ id: z.string().min(1) });
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "参数不合法" }, { status: 400 });
  }
  deleteCustomPreset(body.data.id);
  return NextResponse.json({ ok: true });
}
