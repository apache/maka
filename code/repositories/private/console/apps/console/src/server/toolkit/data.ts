/**
 * toolkit 域数据层：只读 K12 workspace / 批量账号数据 / outlook007 批量产物。
 * 数据文件由迁移落位 + CLI `toolkit batch-email` 写入 apps/console/data/toolkit/，
 * 全目录 gitignored。
 */

import fs from "node:fs";
import path from "node:path";

function toolkitDataDir(): string {
  return process.env.CONSOLE_DATA_DIR
    ? path.resolve(process.env.CONSOLE_DATA_DIR, "toolkit")
    : path.resolve(process.cwd(), "data/toolkit");
}

function readJsonIfExists(p: string): unknown | null {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export interface ToolkitAccountSummary {
  file: string;
  email: string;
  accountId: string;
  planType: string;
  expired: string | null;
  lastRefresh: string | null;
  disabled: boolean;
  mtime: string;
}

/** 37 个 outlook 账号的 codex token 摘要（config/37_* 迁移自 k12 config）。 */
export function listAccounts(): ToolkitAccountSummary[] {
  const dir = path.join(toolkitDataDir(), "accounts");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const full = path.join(dir, f);
      const raw = readJsonIfExists(full) as Record<string, unknown> | null;
      return {
        file: f,
        email: String(raw?.email ?? f.replace(/\.json$/, "")),
        accountId: String(raw?.account_id ?? ""),
        planType: String(raw?.plan_type ?? ""),
        expired: typeof raw?.expired === "string" ? raw.expired : null,
        lastRefresh: typeof raw?.last_refresh === "string" ? raw.last_refresh : null,
        disabled: raw?.disabled === true,
        mtime: fs.statSync(full).mtime.toISOString(),
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** 单个账号完整凭证（?file= 传 basename）。 */
export function readAccountFile(file: string): unknown | null {
  const name = path.basename(file);
  const p = path.join(toolkitDataDir(), "accounts", name);
  if (!fs.existsSync(p)) return null;
  return readJsonIfExists(p);
}

export interface WorkspaceInfo {
  workspaces: unknown | null;
  idsText: string | null;
}

/** workspace SSOT（workspaces.json + workspace-ids.txt）。 */
export function getWorkspaces(): WorkspaceInfo {
  const dir = path.join(toolkitDataDir(), "workspaces");
  return {
    workspaces: readJsonIfExists(path.join(dir, "workspaces.json")),
    idsText: fs.existsSync(path.join(dir, "workspace-ids.txt"))
      ? fs.readFileSync(path.join(dir, "workspace-ids.txt"), "utf8")
      : null,
  };
}

export interface ToolkitOverview {
  accountsTotal: number;
  accountsDisabled: number;
  hasWorkspaces: boolean;
  batchRuns: Array<{ date: string; success: number; failed: number; total: number }>;
}

export function getOverview(): ToolkitOverview {
  const accounts = listAccounts();
  const outDir = path.join(toolkitDataDir(), "output");
  const batchRuns: ToolkitOverview["batchRuns"] = [];
  if (fs.existsSync(outDir)) {
    for (const d of fs.readdirSync(outDir).sort().reverse()) {
      const sum = readJsonIfExists(path.join(outDir, d, "_summary.json")) as Record<string, unknown> | null;
      if (sum) {
        batchRuns.push({
          date: d,
          success: Number(sum.success ?? 0),
          failed: Number(sum.failed ?? 0),
          total: Number(sum.total ?? 0),
        });
      }
    }
  }
  return {
    accountsTotal: accounts.length,
    accountsDisabled: accounts.filter((a) => a.disabled).length,
    hasWorkspaces: getWorkspaces().workspaces !== null,
    batchRuns,
  };
}

/** mail-lists 下的文本清单（文件名 → 内容）。 */
export function getMailLists(): Array<{ file: string; content: string }> {
  const dir = path.join(toolkitDataDir(), "mail-lists");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({ file: f, content: fs.readFileSync(path.join(dir, f), "utf8") }));
}
