import { NextResponse } from "next/server";
import { z } from "zod";
import { exportCpaTar } from "@/server/assets/exporter";
import { ACCOUNT_STATUSES, DEFAULT_EXPORT_STATUSES, type AccountStatus } from "@ggbdpq/console-shared";
import { readJson, jsonError } from "@/server/assets/api-utils";

const exportSchema = z.object({
  batchIds: z.array(z.number().int()).optional(),
  statuses: z.array(z.enum(ACCOUNT_STATUSES)).optional(),
});

export async function POST(req: Request) {
  const body = exportSchema.safeParse(await readJson(req));
  if (!body.success) return jsonError("参数不合法");
  const result = await exportCpaTar({
    batchIds: body.data.batchIds,
    statuses: body.data.statuses ?? DEFAULT_EXPORT_STATUSES,
  });
  return NextResponse.json(result);
}
