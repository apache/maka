import { Command } from "commander";
import type { Toolkit } from "@ggbdpq/inventory-core";
import { catalogPlugin } from "@ggbdpq/inventory-core";
import { marketplacePlugin } from "@ggbdpq/inventory-core";
import { WorkspaceService } from "@ggbdpq/inventory-core";
import { pipelinePlugin } from "@ggbdpq/inventory-core";

export type CliIO = {
  toolkit: Toolkit;
  write: (line: string) => void;
};

export function createProgram(io: CliIO) {
  marketplacePlugin.apply(io.toolkit);
  catalogPlugin.apply(io.toolkit);
  pipelinePlugin.apply(io.toolkit);

  const program = new Command();
  program.name("tokens");
  program.description("数字权益库存工作台 CLI");
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => io.write(str.trimEnd()),
    writeErr: (str) => io.write(str.trimEnd()),
  });

  program.command("doctor").description("检查运行时与已注册工具").action(() => {
    io.write(`node ${process.version}`);
    io.write(`tools ${io.toolkit.jobs.list().join(",")}`);
  });

  program.command("report").description("输出本地库存摘要").action(() => {
    const workspace = io.toolkit.seams.consume("marketplace") as WorkspaceService;
    const summary = workspace.summary();
    io.write(`events ${io.toolkit.events.list().length}`);
    io.write(`availableCents ${summary.wallet.availableCents}`);
  });

  program.command("replay").description("回放 fixture 任务到事件日志").action(async () => {
    const result = await io.toolkit.jobs.run("replay", {
      jobs: [{ type: "replay.sample", payload: { source: "fixture" } }],
    });
    io.write(JSON.stringify(result));
  });

  program.command("replenish").description("对照市价预算执行本地补池").action(async () => {
    const result = await io.toolkit.jobs.run("replenish", {});
    io.write(
      JSON.stringify({
        ...result,
        events: io.toolkit.events.list().map((event) => event.type),
      }),
    );
  });

  program.command("import").description("把授权库存导入本地号池").action(async () => {
    const result = await io.toolkit.jobs.run("authorized-import", {});
    io.write(JSON.stringify(result));
  });

  program.command("mail").description("读取 fixture 收件箱并写入事件日志").action(async () => {
    const result = await io.toolkit.jobs.run("mail-inbox", {});
    io.write(JSON.stringify(result));
  });

  return program;
}
