import { NextResponse } from "next/server";
import { collectSpecs } from "@/server/governance/workspace";

export async function GET() {
  const { specs, warnings } = await collectSpecs();
  return NextResponse.json({ specs, warnings });
}
