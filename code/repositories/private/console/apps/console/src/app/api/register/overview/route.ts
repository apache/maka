import { NextResponse } from "next/server";
import { getOverview } from "@/server/register/db";

export async function GET() {
  return NextResponse.json({ overview: getOverview() });
}
