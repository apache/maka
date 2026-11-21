#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createToolkit } from "@ggbdpq/inventory-core";
import { createDiffmapCommand } from "@ggbdpq/diffmap-core";
import { createPrismCommand } from "@ggbdpq/prism-core";
import { createRegisterCommand } from "@ggbdpq/register-core";
import { createToolkitCommand } from "@ggbdpq/toolkit-core";
import { createProgram } from "./tokens";

// 统一控制台 CLI。doctor 走真 HTTP；tokens 子命令组（doctor/report/replay/import/mail/replenish）
// 自 tokens-toolkit CLI 并入，进程内 toolkit（内存库）；register 子命令组自 gpt-free-register 并入。
const program = new Command();

program.name("console-cli").description("个人 Agent 控制台 CLI").version("0.1.0");

program
  .command("doctor")
  .description("检查控制台 API 可达性与本地数据目录")
  .action(async () => {
    const base = process.env.CONSOLE_API ?? "http://localhost:65501";
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5_000) });
      const body = (await res.json()) as { ok?: boolean };
      console.log(body.ok ? "console API: ok" : "console API: 异常响应");
    } catch (error) {
      console.error(`无法连接 ${base}（${(error as Error).message}），请先 pnpm dev`);
      process.exitCode = 1;
    }
  });

program.addCommand(
  createProgram({
    toolkit: createToolkit({ dbPath: process.env.TOKENS_DB ?? ":memory:" }),
    write: (line) => console.log(line),
  }),
);

// register 域数据（SQLite/token 落盘/日志）统一锚定 apps/console/data/register/（gitignored），
// 以本文件位置定位，任何 CWD 下一致；显式环境变量优先。
const registerDataDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/console/data/register",
);
const registerCmd = createRegisterCommand();
registerCmd.hook("preAction", () => {
  process.env.DB_PATH ||= path.join(registerDataDir, "app.db");
  process.env.LOG_DIR ||= path.join(registerDataDir, "logs");
  process.env.TOKEN_OUTPUT_DIRS ||= path.join(registerDataDir, "tokens");
});
program.addCommand(registerCmd);

// toolkit 批量注册产物落 apps/console/data/toolkit/output/（gitignored）。
const toolkitCmd = createToolkitCommand();
toolkitCmd.hook("preAction", () => {
  process.env.OUTLOOK007_OUT_DIR ||= path.join(registerDataDir, "../toolkit/output");
});
program.addCommand(toolkitCmd);

// prism 子命令组（endpoint 直调/smoke/browser-probe）自 prismctl 并入（六期）；无落盘状态。
program.addCommand(createPrismCommand());

// diffmap 子命令自 diffmap 并入（六期）：定位仓库并打开 agent 应用 /diffmap（web 随 65504 服务）。
program.addCommand(createDiffmapCommand());

program.parseAsync(process.argv);
