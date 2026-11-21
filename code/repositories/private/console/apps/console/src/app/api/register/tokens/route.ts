import { NextResponse } from "next/server";
import { listTokenFiles, listTokens, readTokenFile } from "@/server/register/db";

/** ?file=<basename> 读取单个 token 落盘文件内容；否则列库内 token 记录与落盘文件清单。 */
export async function GET(req: Request) {
  const file = new URL(req.url).searchParams.get("file");
  if (file) {
    const content = readTokenFile(file);
    if (content === null) return NextResponse.json({ code: "NOT_FOUND", message: "token 文件不存在" }, { status: 404 });
    return NextResponse.json({ file, content });
  }
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? 200);
  return NextResponse.json({ tokens: listTokens(Number.isFinite(limit) ? limit : 200), files: listTokenFiles() });
}
