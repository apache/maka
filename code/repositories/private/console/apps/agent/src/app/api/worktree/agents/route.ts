import { NextResponse } from "next/server";
import { z } from "zod";
import { agentList, agentSpawn } from "@/server/worktree/projects";
import { readJson } from "@/server/api-utils";

export async function GET(req: Request) {
  const projectId = new URL(req.url).searchParams.get("projectId") ?? undefined;
  return NextResponse.json({ agents: await agentList(projectId) });
}

const spawnSchema = z.object({ projectId: z.string().min(1), agentName: z.string().min(1) });

export async function POST(req: Request) {
  const body = spawnSchema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "projectId 与 agentName 必填" }, { status: 400 });
  }
  try {
    return NextResponse.json({ agent: await agentSpawn(body.data) }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { code: "SPAWN_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
