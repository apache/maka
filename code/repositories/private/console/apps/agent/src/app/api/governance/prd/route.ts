import { NextResponse } from "next/server";
import { buildPrdDocument } from "@/server/governance/workspace";

export async function GET() {
  const { document, sources } = await buildPrdDocument();
  return NextResponse.json({ document, sources });
}
