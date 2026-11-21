import { NextResponse } from "next/server";
import { z } from "zod";
import { importOriginal } from "@/server/assets/store";
import { parseJsonl } from "@ggbdpq/console-shared";
import { readJson, jsonError } from "@/server/assets/api-utils";
import { saveToInbox } from "@/server/assets/import-utils";

const importSchema = z.object({
  text: z.string().min(1),
  batchId: z.number().int().positive().optional(),
  fileName: z.string().optional(),
});

export async function POST(req: Request) {
  const body = importSchema.safeParse(await readJson(req));
  if (!body.success) return jsonError("需要 text 字段");
  const records = parseJsonl(body.data.text);
  if (body.data.fileName) saveToInbox(body.data.fileName, body.data.text);
  if (records.length === 0) return jsonError("未解析到任何账号记录");
  return NextResponse.json({
    parsed: records.length,
    ...importOriginal(records, body.data.batchId ?? null),
  });
}
