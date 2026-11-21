// diffmap 报告端点（六期自 diffmap server.ts 并入，单进程宪法）：?repo/mode/base 透传提取引擎，
// 模块级缓存沿袭 server.ts 语义——HEAD 变化或 ?refresh=1 时重算；缓存 key 含 repoRoot（共享服务下多仓并存）。
import { NextRequest, NextResponse } from "next/server";
import { extractReport, findRepoRoot, resolveRef, type DiffMode, type DiffReport } from "@ggbdpq/diffmap-core";

let cache: { key: string; report: DiffReport; ms: number } | null = null;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  try {
    const repoRoot = await findRepoRoot(sp.get("repo") ?? process.cwd());
    const mode: DiffMode = sp.get("mode") === "base" ? "base" : "worktree";
    const baseRef = sp.get("base") ?? undefined;
    const headSha = await resolveRef("HEAD", repoRoot);
    const key = `${repoRoot}|${mode}|${baseRef ?? ""}|${headSha}`;

    if (sp.get("refresh") !== "1" && cache && cache.key === key) {
      return NextResponse.json(cache.report);
    }
    const t0 = Date.now();
    const report = await extractReport({ repoRoot, mode, baseRef });
    cache = { key, report, ms: Date.now() - t0 };
    console.log(`[diffmap] 提取变更集：${report.files.length} 个文件，+${report.totalAdditions}/-${report.totalDeletions}，耗时 ${cache.ms}ms`);
    return NextResponse.json(report);
  } catch (err) {
    console.error("[diffmap] 提取失败：", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
