import { NextResponse } from "next/server";
import { projectStatus } from "@/server/worktree/projects";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return NextResponse.json(await projectStatus(id));
  } catch (e) {
    return NextResponse.json(
      { code: "NOT_FOUND", message: e instanceof Error ? e.message : String(e) },
      { status: 404 },
    );
  }
}
