// 自 diffmap src/cli.ts 并入（六期）：原版"起本地服务+开浏览器"改为生成 agent 应用
// /diffmap 路由的 URL（单进程宪法，server.ts 由 Next route handler 取代）。
// --base 校验语义（空值/以 - 开头报错退出并强制 base 模式）是源仓最后的脏区改动，原样保留。
import { Command } from "commander";
import { exec } from "node:child_process";
import { findRepoRoot } from "./git.ts";
import type { DiffMode } from "./types.ts";

export const DEFAULT_AGENT_BASE = process.env.DIFFMAP_AGENT_BASE ?? "http://localhost:65504";

export interface DiffmapCliArgs {
  mode: DiffMode;
  baseRef?: string;
  open: boolean;
  help: boolean;
}

export class DiffmapCliError extends Error {}

export function parseDiffmapArgs(argv: string[]): DiffmapCliArgs {
  const args: DiffmapCliArgs = { mode: "worktree", open: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") args.help = true;
    else if (a === "--no-open") args.open = false;
    else if (a === "--base" || a.startsWith("--base=")) {
      const baseRef = a === "--base" ? argv[++i] : a.slice("--base=".length);
      if (!baseRef?.trim() || baseRef.startsWith("-")) {
        throw new DiffmapCliError("--base 需要分支或提交引用");
      }
      args.baseRef = baseRef;
      args.mode = "base";
    } else {
      throw new DiffmapCliError(`未知参数：${a}（-h 看用法）`);
    }
  }
  return args;
}

/** 拼 agent 应用里 diffmap 路由的 URL；repo/mode/base 走查询参数，由页面转交 API */
export function buildDiffmapUrl({ repoRoot, mode, baseRef, agentBase = DEFAULT_AGENT_BASE }: {
  repoRoot: string;
  mode: DiffMode;
  baseRef?: string;
  agentBase?: string;
}): string {
  const params = new URLSearchParams({ repo: repoRoot, mode });
  if (baseRef) params.set("base", baseRef);
  return `${agentBase.replace(/\/+$/, "")}/diffmap?${params.toString()}`;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* 打不开就让用户手动访问，不当作致命错误 */
  });
}

export function createDiffmapCommand(): Command {
  const command = new Command("diffmap");
  command.description("把 git 变更渲染成 treemap 的审查工具（web 在 agent 应用 /diffmap，本命令负责定位仓库并打开）")
    .argument("[path]", "要审查的仓库路径（默认当前目录）")
    .option("--base <ref>", "审查整个分支相对 <ref> 的变更（默认：未提交变更）")
    .option("--no-open", "只打印 URL 不打开浏览器")
    .action(async (pathArg: string | undefined, opts: { base?: string; open: boolean }) => {
      try {
        const args = parseDiffmapArgs(opts.base === undefined ? [] : ["--base", opts.base]);
        if (args.help) {
          console.log("console-cli diffmap [path] [--base <ref>] [--no-open]");
          return;
        }
        const repoRoot = await findRepoRoot(pathArg ?? process.cwd());
        const url = buildDiffmapUrl({ repoRoot, mode: args.mode, baseRef: args.baseRef });
        console.log(`[diffmap] 仓库：${repoRoot}`);
        console.log(`[diffmap] 模式：${args.mode === "base" ? `vs ${args.baseRef}` : "未提交变更"}`);
        console.log(`[diffmap] ${url}  （需先 pnpm dev 起 agent 应用）`);
        if (args.open && opts.open) openBrowser(url);
      } catch (err) {
        if (err instanceof DiffmapCliError) {
          console.error(`[diffmap] ${err.message}`);
          process.exitCode = 2;
          return;
        }
        console.error(`[diffmap] ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });
  return command;
}
