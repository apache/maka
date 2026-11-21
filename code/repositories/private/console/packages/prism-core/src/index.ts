// prism-core：OpenAI Prism 本地接口调用引擎（六期自 prismctl 并入）。
// 引擎（endpoints/http/smoke/browser-context）与 CLI 壳（cli.ts）都在这里，
// apps/cli 只挂 createPrismCommand。
import { Command } from "commander";

export {
  ENDPOINTS,
  endpointNames,
  getEndpoint,
  type EndpointDef,
} from "./endpoints.ts";
export {
  buildRequest,
  redactHeaders,
  sendRequest,
  type RequestInput,
  type BuiltRequest,
} from "./http.ts";
export {
  loadSmokeConfig,
  planSmokeSteps,
  renderSmokeReport,
  runSmoke,
  type SmokeConfig,
  type SmokeReport,
  type SmokeResult,
  type SmokeStep,
} from "./smoke.ts";
export {
  cookieHeaderToCdpCookies,
  loadBrowserConfig,
  makeBrowserFetchExpression,
  redactBrowserResult,
  renderBrowserReport,
  runBrowserProbe,
  type BrowserProbeOptions,
  type BrowserReport,
} from "./browser-context.ts";
export { runPrismCli } from "./cli.ts";
import { runPrismCli } from "./cli.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSmokeConfig, renderSmokeReport, runSmoke } from "./smoke.ts";
import { loadBrowserConfig, runBrowserProbe } from "./browser-context.ts";

function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

// smoke/browser-probe 报告默认落包内 verification/（gitignore 不覆盖时也不会污染仓库根——
// 与源仓一致的行为，PRISM_REPORT_DIR 可覆盖）。
const DEFAULT_REPORT_DIR = fileURLToPath(new URL("../verification", import.meta.url));

export function createPrismCommand(): Command {
  const prism = new Command("prism");
  prism.description("OpenAI Prism 本地接口调用（endpoints 直调 / smoke / browser-probe）");

  prism
    .command("smoke", { isDefault: false })
    .description("四步冒烟（create→upload→render→render-status），默认 dry-run，PRISM_LIVE=1 或 --live 切真打")
    .allowUnknownOption()
    .helpOption(false)
    .argument("[args...]")
    .action(async (args: string[]) => {
      const config = loadSmokeConfig(args);
      const report = await runSmoke(config);
      const dir = config.reportDir || DEFAULT_REPORT_DIR;
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${config.mode === "live" ? "live" : "dry-run"}-smoke-${isoStamp()}.md`);
      await writeFile(path, renderSmokeReport(report), "utf8");
      console.log(path);
      console.log(`STATUS=${report.status}`);
      process.exitCode = report.status === "PASS" ? 0 : 1;
    });

  prism
    .command("browser-probe")
    .description("起 Chrome CDP 注入 cookie 后同源探测（PRISM_COOKIE 必需）")
    .allowUnknownOption()
    .helpOption(false)
    .argument("[args...]")
    .action(async () => {
      const config = { ...loadBrowserConfig(), reportDir: process.env.PRISM_REPORT_DIR || DEFAULT_REPORT_DIR };
      const { path, report } = await runBrowserProbe(config);
      console.log(path);
      console.log(`STATUS=${report.status}`);
      process.exitCode = report.status === "PASS" ? 0 : 1;
    });

  // 端点名是开放集合（list-endpoints 可枚举），不逐个注册子命令，透传给手写解析器。
  prism
    .command("endpoint", { isDefault: true })
    .argument("[args...]")
    .allowUnknownOption()
    .helpOption(false)
    .action(async (args: string[]) => {
      process.exitCode = await runPrismCli(args);
    });

  return prism;
}
