import { NextResponse } from "next/server";
import { z } from "zod";
import { claim } from "@/server/workflow/execution";
import { readJson } from "@/server/api-utils";

// worker 原子 claim：PENDING → CLAIMED
const schema = z.object({ workerId: z.string().min(1), limit: z.number().int().positive().max(10).optional() });

export async function POST(req: Request) {
  const body = schema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "workerId 必填" }, { status: 400 });
  }
  return NextResponse.json(claim(body.data));
}
