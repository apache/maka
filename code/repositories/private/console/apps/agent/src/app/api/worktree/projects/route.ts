import { NextResponse } from "next/server";
import { z } from "zod";
import { projectAdd, projectList } from "@/server/worktree/projects";
import { readJson } from "@/server/api-utils";

export async function GET() {
  try {
    return NextResponse.json({ projects: await projectList() });
  } catch (e) {
    return NextResponse.json(
      { code: "LIST_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

const addSchema = z.object({ name: z.string().min(1), path: z.string().min(1) });

export async function POST(req: Request) {
  const body = addSchema.safeParse(await readJson(req));
  if (!body.success) {
    return NextResponse.json({ code: "VALIDATION_ERROR", message: "name 与 path 必填" }, { status: 400 });
  }
  try {
    return NextResponse.json(
      { project: await projectAdd({ name: body.data.name, projectPath: body.data.path }) },
      { status: 201 },
    );
  } catch (e) {
    return NextResponse.json(
      { code: "ADD_FAILED", message: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
