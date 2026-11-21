import { NextResponse } from "next/server";
import { z } from "zod";
import { createTask, listTasks } from "@/server/workflow/tasks";
import { readJson } from "@/server/api-utils";

const createSchema = z.object({
  title: z.string().min(1),
  spec: z.unknown().optional(),
  userId: z.string().optional(),
});

export async function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 50);
  return NextResponse.json({ tasks: listTasks(limit) });
}

export async function POST(req: Request) {
  const body = createSchema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "title 必填" }, { status: 400 });
  }
  const task = createTask({ title: body.data.title, spec: body.data.spec ?? {}, userId: body.data.userId });
  return NextResponse.json({ task }, { status: 201 });
}
