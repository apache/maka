import { NextResponse } from "next/server";
import { getTask, listExecutionsByTask } from "@/server/workflow/tasks";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ code: "NOT_FOUND", message: "任务不存在" }, { status: 404 });
  return NextResponse.json({ task, executions: listExecutionsByTask(id) });
}
