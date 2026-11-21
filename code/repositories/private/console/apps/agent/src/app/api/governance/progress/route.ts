import { NextResponse } from "next/server";
import { collectProgressEntries } from "@/server/governance/workspace";

export async function GET() {
  const { entries, warnings, sources } = await collectProgressEntries();
  return NextResponse.json({ entries, warnings, sources });
}
