import { NextResponse } from "next/server";
import { projectPull } from "@/server/worktree/projects";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return NextResponse.json(await projectPull(id));
  } catch (e) {
    return NextResponse.json(
      { code: "PULL_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }
}
