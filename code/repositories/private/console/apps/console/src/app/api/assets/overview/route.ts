import { NextResponse } from "next/server";
import { getSetting } from "@/server/assets/db";
import { overview } from "@/server/assets/store";

export async function GET() {
  const warnDays = parseInt(getSetting("warn_days") || "7", 10);
  return NextResponse.json(overview(warnDays));
}
