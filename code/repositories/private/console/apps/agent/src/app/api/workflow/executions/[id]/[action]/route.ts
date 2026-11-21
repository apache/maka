import { NextResponse } from "next/server";
import * as exec from "@/server/workflow/execution";

// 生命周期转换端点工厂：start / heartbeat / complete / fail / progress 共用形态
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  try {
    switch (action) {
      case "start":
        return NextResponse.json({ execution: exec.start(id) });
      case "heartbeat":
        return NextResponse.json({ execution: exec.heartbeat(id) });
      case "progress":
        return NextResponse.json({
          execution: exec.progress(id, Number(body.progress ?? 0), body.currentStep as string | undefined),
        });
      case "complete":
        return NextResponse.json({ execution: exec.complete(id, body.result ?? null) });
      case "fail":
        return NextResponse.json({ execution: exec.fail(id, body.error ?? "unknown") });
      default:
        return NextResponse.json({ code: "NOT_FOUND", message: `未知操作 ${action}` }, { status: 404 });
    }
  } catch (e) {
    return NextResponse.json(
      { code: "TRANSITION_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
