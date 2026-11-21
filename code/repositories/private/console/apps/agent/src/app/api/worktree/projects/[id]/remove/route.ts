import { NextResponse } from "next/server";
import { projectRemove } from "@/server/worktree/projects";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return NextResponse.json({ removed: projectRemove(id) });
}
