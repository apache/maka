import { NextResponse } from "next/server";
import { collectGitCommits } from "@/server/governance/workspace";

export async function GET(req: Request) {
  const limitParam = new URL(req.url).searchParams.get("limit");
  const limit = limitParam ? Math.min(1000, Math.max(1, Number(limitParam) || 200)) : 200;
  const { commits, root, error } = await collectGitCommits(limit);
  return NextResponse.json({ commits, root, error });
}
