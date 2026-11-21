import { z } from "zod";
import { getInventoryRuntime } from "@/server/inventory/runtime";
import { handle, parseBody, readJson } from "@/server/inventory/http";

const depositSchema = z.object({
  amountCents: z.number().int().positive(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const body = parseBody(depositSchema, await readJson(req));
    return getInventoryRuntime().workspace.deposit(body.amountCents);
  });
}
