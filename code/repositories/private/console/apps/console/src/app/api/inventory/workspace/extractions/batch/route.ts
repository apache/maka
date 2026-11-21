import { z } from "zod";
import { getInventoryRuntime } from "@/server/inventory/runtime";
import { handle, parseBody, readJson } from "@/server/inventory/http";

const estimateSchema = z.object({
  quantity: z.number().int().positive(),
  plan: z.string().min(1),
  maxUnitPriceCents: z.number().int().nullable().optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const body = parseBody(estimateSchema, await readJson(req));
    return getInventoryRuntime().workspace.purchase({
      quantity: body.quantity,
      plan: body.plan,
      maxUnitPriceCents: body.maxUnitPriceCents ?? null,
    });
  });
}
