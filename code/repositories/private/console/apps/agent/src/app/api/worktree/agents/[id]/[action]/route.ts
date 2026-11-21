import { NextResponse } from "next/server";
import * as m from "@/server/worktree/projects";
import { readJson } from "@/server/api-utils";

// agent sync/merge/remove/commits/diff 共用形态：POST body 可带空对象
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await ctx.params;
  await readJson(req); // 容错消费 body
  try {
    switch (action) {
      case "sync":
        return NextResponse.json(await m.agentSyncFromMain(id));
      case "merge":
        return NextResponse.json(await m.agentMergeToMain(id));
      case "remove":
        return NextResponse.json({ removed: await m.agentRemove(id) });
      case "commits":
        return NextResponse.json({ commits: await m.agentRecentCommits(id, 10) });
      case "diff":
        return NextResponse.json({ diffStat: await m.agentDiffStat(id) });
      default:
        return NextResponse.json({ code: "NOT_FOUND", message: `未知操作 ${action}` }, { status: 404 });
    }
  } catch (e) {
    return NextResponse.json(
      { code: "AGENT_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  return POST(req, ctx);
}
