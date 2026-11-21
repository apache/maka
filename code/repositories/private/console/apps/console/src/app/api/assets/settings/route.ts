import { NextResponse } from "next/server";
import { z } from "zod";
import { getSetting, setSetting, getExpireRule } from "@/server/assets/db";
import { defaultCardRoot, cliProxyCardRoot, getCardRoot } from "@/server/assets/scanner";
import { ACCOUNT_STATUSES, DEFAULT_EXPORT_STATUSES } from "@ggbdpq/console-shared";
import { readJson, jsonError } from "@/server/assets/api-utils";

export async function GET() {
  return NextResponse.json({
    expire_rule: getExpireRule(),
    warn_days: parseInt(getSetting("warn_days") || "7", 10),
    card_root: getCardRoot(),
    scan_roots: {
      purchase_root: defaultCardRoot(),
      cli_proxy_root: cliProxyCardRoot(),
    },
    statuses: ACCOUNT_STATUSES,
    default_export_statuses: DEFAULT_EXPORT_STATUSES,
  });
}

const putSchema = z.object({
  expire_rule: z.enum(["month", "30d", "28d"]).optional(),
  warn_days: z.number().int().min(1).max(60).optional(),
  card_root: z.string().optional(),
});

export async function PUT(req: Request) {
  const body = putSchema.safeParse(await readJson(req));
  if (!body.success) return jsonError("参数不合法");
  if (body.data.expire_rule) setSetting("expire_rule", body.data.expire_rule);
  if (body.data.warn_days) setSetting("warn_days", String(body.data.warn_days));
  if (body.data.card_root !== undefined) setSetting("card_root", body.data.card_root);
  return NextResponse.json({ ok: true });
}
