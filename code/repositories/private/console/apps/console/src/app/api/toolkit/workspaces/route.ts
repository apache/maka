import { NextResponse } from "next/server";
import { getMailLists, getWorkspaces } from "@/server/toolkit/data";

export async function GET() {
  const ws = getWorkspaces();
  return NextResponse.json({ workspaces: ws.workspaces, idsText: ws.idsText, mailLists: getMailLists() });
}
