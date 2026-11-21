import { NextResponse } from "next/server";
import { listAccounts, readAccountFile } from "@/server/toolkit/data";

/** ?file=<basename> 读取单个账号完整凭证；否则列账号摘要。 */
export async function GET(req: Request) {
  const file = new URL(req.url).searchParams.get("file");
  if (file) {
    const content = readAccountFile(file);
    if (content === null) return NextResponse.json({ code: "NOT_FOUND", message: "账号文件不存在" }, { status: 404 });
    return NextResponse.json({ file, content });
  }
  return NextResponse.json({ accounts: listAccounts() });
}
