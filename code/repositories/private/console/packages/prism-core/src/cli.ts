// 自 prismctl.ts 并入（六期）：手写 argv 解析原样保留，入口由裸脚本改为 runPrismCli 导出，
// 供 apps/cli 的 prism 命令组与进程内测试共用。
import { readFile } from "node:fs/promises";
import { ENDPOINTS, endpointNames, getEndpoint } from "./endpoints.ts";
import { buildRequest, redactHeaders, sendRequest } from "./http.ts";

const USAGE = `console-cli prism - local Prism interface caller

Usage:
  console-cli prism list-endpoints
  console-cli prism <endpoint> [options]

Screenshot endpoints:
  create-project                 POST  /api/projects
  project-access --d UUID         GET   /api/project-access?d=UUID
  conversation-history --json ... POST  /api/codex/conversation-history
  llm-start --json ...            POST  /api/llm/response_with_tools_start
  llm-status --json ...           POST  /api/llm/response_with_tools_status
  render --json ...               POST  /s/sandboxes/proxy/render
  render-status [--wait-ms 10000] GET   /s/sandboxes/proxy/render-status?waitMs=10000
  upload --file ./main.tex        POST  /api/project-files/upload
  thumbnail --uuid UUID --json ... PATCH /api/projects/{uuid}/thumbnail

Auth/session headers:
  PRISM_COOKIE="..." pnpm cli -- prism project-access --d UUID
  PRISM_CSRF_TOKEN="..." pnpm cli -- prism create-project --json '{"project_uuid":"b6d5fe3b-99b4-4e0d-a0d5-5cf4e9cf6273","title":"Test"}'

Options:
  --help, -h            print usage
  --base-url URL        default: PRISM_BASE_URL or https://prism.openai.com
  --cookie VALUE        default: PRISM_COOKIE
  --csrf VALUE          default: PRISM_CSRF_TOKEN
  --header "K: V"       add a header; repeatable
  --json JSON           JSON request body
  --json-file PATH      JSON request body from file
  --query k=v           query parameter; repeatable
  --field k=v           multipart field for upload; repeatable
  --d UUID              shorthand for --query d=UUID
  --uuid UUID           thumbnail path parameter
  --wait-ms N           shorthand for render-status waitMs
  --file PATH           multipart upload file
  --dry-run             print redacted request without sending
`;

function take(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

function assignPair(target: Record<string, string>, pair: string, flag: string) {
  const sep = pair.indexOf("=");
  if (sep < 1) throw new Error(`${flag} expects k=v`);
  target[pair.slice(0, sep)] = pair.slice(sep + 1);
}

interface CliOptions {
  baseUrl: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  fields: Record<string, string>;
  pathParams: Record<string, string>;
  help?: boolean;
  dryRun?: boolean;
  body?: unknown;
  file?: string;
}

async function parseArgs(argv: string[]): Promise<{ command: string | undefined; opts: CliOptions }> {
  const command = argv[0];
  const opts: CliOptions = {
    baseUrl: process.env.PRISM_BASE_URL || "https://prism.openai.com",
    headers: {},
    query: {},
    fields: {},
    pathParams: {},
  };

  if (process.env.PRISM_COOKIE) opts.headers.cookie = process.env.PRISM_COOKIE;
  if (process.env.PRISM_CSRF_TOKEN) opts.headers["x-csrf-token"] = process.env.PRISM_CSRF_TOKEN;

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--base-url") opts.baseUrl = take(argv, i++, arg);
    else if (arg === "--cookie") opts.headers.cookie = take(argv, i++, arg);
    else if (arg === "--csrf") opts.headers["x-csrf-token"] = take(argv, i++, arg);
    else if (arg === "--header") {
      const raw = take(argv, i++, arg);
      const sep = raw.indexOf(":");
      if (sep < 1) throw new Error("--header expects 'K: V'");
      opts.headers[raw.slice(0, sep).trim()] = raw.slice(sep + 1).trim();
    } else if (arg === "--json") opts.body = JSON.parse(take(argv, i++, arg));
    else if (arg === "--json-file") opts.body = JSON.parse(await readFile(take(argv, i++, arg), "utf8"));
    else if (arg === "--query") assignPair(opts.query, take(argv, i++, arg), arg);
    else if (arg === "--field") assignPair(opts.fields, take(argv, i++, arg), arg);
    else if (arg === "--d") opts.query.d = take(argv, i++, arg);
    else if (arg === "--uuid") opts.pathParams.uuid = take(argv, i++, arg);
    else if (arg === "--wait-ms") opts.query.waitMs = take(argv, i++, arg);
    else if (arg === "--file") opts.file = take(argv, i++, arg);
    else throw new Error(`Unknown option: ${arg}`);
  }

  return { command, opts };
}

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

export async function runPrismCli(argv: string[]): Promise<number> {
  const { command, opts } = await parseArgs(argv);
  if (!command || opts.help || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }

  if (command === "list-endpoints") {
    printJson(endpointNames().map((name) => ({ name, ...ENDPOINTS[name] })));
    return 0;
  }

  const endpoint = getEndpoint(command);
  if (command === "thumbnail" && !opts.pathParams.uuid) throw new Error("thumbnail requires --uuid UUID");
  if (command === "project-access" && !opts.query.d) throw new Error("project-access requires --d UUID");
  if (command === "upload" && !opts.file) throw new Error("upload requires --file PATH");

  const input = {
    endpoint,
    baseUrl: opts.baseUrl,
    pathParams: opts.pathParams,
    query: opts.query,
    headers: opts.headers,
    body: opts.body ?? (endpoint.method === "GET" || opts.file ? undefined : {}),
    file: opts.file,
    fields: opts.fields,
  };

  if (opts.dryRun) {
    const request = await buildRequest(input);
    printJson({
      url: request.url,
      method: request.options.method,
      headers: redactHeaders(request.options.headers),
      hasBody: request.options.body !== undefined,
    });
    return 0;
  }

  const result = await sendRequest(input);
  printJson(result);
  return result.response.ok ? 0 : 2;
}
