import { NextResponse } from "next/server";
import { z } from "zod";
import { getSetting, setSetting } from "@/server/assets/db";
import { clearScannedData } from "@/server/assets/store";
import { scanCardRoot } from "@/server/assets/scanner";
import { readJson, jsonError } from "@/server/assets/api-utils";

const scanSchema = z.object({
  reset: z.boolean().optional(),
  root: z.string().optional(),
  saveDefault: z.boolean().optional(),
});

export async function POST(req: Request) {
  const body = scanSchema.safeParse(await readJson(req));
  if (!body.success) return jsonError("参数不合法");
  const root = body.data.root?.trim() || undefined;
  if (root && body.data.saveDefault) setSetting("card_root", root);
  if (body.data.reset) clearScannedData();
  return NextResponse.json(scanCardRoot(root ?? (getSetting("card_root") || undefined)));
}
