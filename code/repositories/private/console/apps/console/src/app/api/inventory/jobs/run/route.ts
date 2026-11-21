import { z } from "zod";
import { getInventoryRuntime } from "@/server/inventory/runtime";
import { handle, parseBody, readJson } from "@/server/inventory/http";

const jobRunSchema = z.object({
  name: z.string().min(1),
  input: z.unknown().optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const body = parseBody(jobRunSchema, await readJson(req));
    return getInventoryRuntime().toolkit.jobs.run(body.name, body.input);
  });
}
