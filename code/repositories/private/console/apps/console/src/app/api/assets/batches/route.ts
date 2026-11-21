import { NextResponse } from "next/server";
import { listBatches } from "@/server/assets/store";

export async function GET() {
  return NextResponse.json(listBatches());
}
