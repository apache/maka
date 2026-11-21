import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  parseGitLogLine,
  parsePRDContent,
  parseProgressContent,
  readSpec,
  scanSpecs,
  type FileSystemAdapter,
} from "@/server/governance/services";
import type {
  GitCommit,
  PRDDocument,
  PRDItem,
  SpecDocument,
} from "@ggbdpq/console-shared";

// 治理台服务端真实层：扫描根及直接子项目的 .ggbdpq 工件，解析后提供真实数据。
// 替代原 governance 模块中的 mock 数据（"UI-Only" 的缺失后端补齐）。

const execFileAsync = promisify(execFile);

export function resolveGovernanceRoot(): string {
  return process.env.GOVERNANCE_ROOT
    ? path.resolve(process.env.GOVERNANCE_ROOT)
    : path.resolve(process.cwd(), "..", "..");
}

export interface GovernanceProject {
  name: string;
  root: string;
  prdPaths: string[];
  progressPaths: string[];
  specsDir: string | null;
}

export async function listProjects(root: string): Promise<GovernanceProject[]> {
  const projects: GovernanceProject[] = [];
  let entries: string[];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return projects;
  }
  for (const entry of [".", ...entries]) {
    const projectRoot = path.resolve(root, entry);
    const name = path.basename(projectRoot);
    const gg = path.join(projectRoot, ".ggbdpq");
    try {
      await fs.access(gg);
    } catch {
      continue;
    }
    const prdPaths: string[] = [];
    const progressPaths: string[] = [];
    // 惯例一：.ggbdpq/actions/<项目>/prd.json
    const actionsDir = path.join(gg, "actions");
    try {
      for (const action of await fs.readdir(actionsDir, { withFileTypes: true })) {
        if (!action.isDirectory()) continue;
        const prd = path.join(actionsDir, action.name, "prd.json");
        if (await exists(prd)) prdPaths.push(prd);
        const prog = path.join(actionsDir, action.name, "progress.txt");
        if (await exists(prog)) progressPaths.push(prog);
      }
    } catch {
      // 无 actions 目录
    }
    // 惯例二：.ggbdpq 根级工件
    if (await exists(path.join(gg, "prd.json"))) prdPaths.push(path.join(gg, "prd.json"));
    if (await exists(path.join(gg, "progress.txt"))) {
      progressPaths.push(path.join(gg, "progress.txt"));
    }
    const specsDir = path.join(projectRoot, ".kiro", "specs");
    const specs = (await exists(specsDir)) ? specsDir : null;
    projects.push({ name, root: projectRoot, prdPaths, progressPaths, specsDir: specs });
  }
  return projects;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- PRD ----------

export interface PrdSource {
  project: string;
  path: string;
  ok: boolean;
  error?: string;
}

export async function buildPrdDocument(): Promise<{
  document: PRDDocument | null;
  sources: PrdSource[];
}> {
  const root = resolveGovernanceRoot();
  const projects = await listProjects(root);
  const items: PRDItem[] = [];
  const sources: PrdSource[] = [];
  for (const project of projects) {
    for (const prdPath of project.prdPaths) {
      try {
        const content = await fs.readFile(prdPath, "utf-8");
        const result = parsePRDContent(content);
        if (result.success) {
          items.push(...result.data.items);
          sources.push({ project: project.name, path: prdPath, ok: true });
        } else {
          sources.push({
            project: project.name,
            path: prdPath,
            ok: false,
            error: [result.error.message, result.error.details].filter(Boolean).join(": "),
          });
        }
      } catch (err) {
        sources.push({
          project: project.name,
          path: prdPath,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  if (items.length === 0) return { document: null, sources };
  const passing = items.filter((i) => i.passes).length;
  const total = items.length;
  return {
    document: {
      items,
      statistics: {
        total,
        passing,
        failing: total - passing,
        completion: total > 0 ? `${Math.round((passing / total) * 100)}%` : "0%",
        blocked_reason: "",
      },
    },
    sources,
  };
}

// ---------- Progress ----------

export interface ProgressSource {
  project: string;
  path: string;
  ok: boolean;
  error?: string;
}

export interface RawProgressEntry {
  project: string;
  datetime: string | null;
  prdId: string;
  component: string;
  priority: string;
  what: string;
  why: string;
  typecheckResult: string;
  commitMessage: string;
  next: string;
}

export async function collectProgressEntries(): Promise<{
  entries: RawProgressEntry[];
  warnings: string[];
  sources: ProgressSource[];
}> {
  const root = resolveGovernanceRoot();
  const projects = await listProjects(root);
  const entries: RawProgressEntry[] = [];
  const warnings: string[] = [];
  const sources: ProgressSource[] = [];
  for (const project of projects) {
    for (const progressPath of project.progressPaths) {
      try {
        const content = await fs.readFile(progressPath, "utf-8");
        const result = parseProgressContent(content);
        warnings.push(...result.warnings);
        for (const e of result.entries) {
          if (!e.prdId || !e.what || !e.datetime) continue;
          entries.push({
            project: project.name,
            datetime: e.datetime instanceof Date ? e.datetime.toISOString() : String(e.datetime),
            prdId: e.prdId ?? "",
            component: e.component ?? "",
            priority: e.priority ?? "P0",
            what: e.what ?? "",
            why: e.why ?? "",
            typecheckResult: e.typecheckResult ?? "",
            commitMessage: e.commitMessage ?? "",
            next: e.next ?? "",
          });
        }
        sources.push({ project: project.name, path: progressPath, ok: true });
      } catch (err) {
        sources.push({
          project: project.name,
          path: progressPath,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { entries, warnings, sources };
}

// ---------- Specs ----------

export async function collectSpecs(): Promise<{
  specs: SpecDocument[];
  warnings: string[];
}> {
  const root = resolveGovernanceRoot();
  const projects = await listProjects(root);
  const adapter: FileSystemAdapter = {
    exists: async (p) => exists(p),
    isDirectory: async (p) => {
      try {
        return (await fs.stat(p)).isDirectory();
      } catch {
        return false;
      }
    },
    readDir: async (p) => {
      try {
        return (await fs.readdir(p, { withFileTypes: true })).map((e) => e.name);
      } catch {
        return [];
      }
    },
    readFile: async (p) => fs.readFile(p, "utf-8"),
  };
  const specs: SpecDocument[] = [];
  const warnings: string[] = [];
  for (const project of projects) {
    if (!project.specsDir) continue;
    try {
      const scan = await scanSpecs(project.specsDir, adapter);
      warnings.push(...scan.warnings.map((w) => `[${project.name}] ${w}`));
      for (const name of scan.specs) {
        const read = await readSpec(`${project.specsDir}/${name}`, adapter);
        if (read.success) specs.push(read.data);
        else warnings.push(`[${project.name}] ${name}: ${read.error}`);
      }
    } catch (err) {
      warnings.push(`[${project.name}] specs 扫描失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { specs, warnings };
}

// ---------- Git ----------

export interface GitCommitDto {
  sha: string;
  author: string;
  date: string;
  message: string;
}

export async function collectGitCommits(limit = 200): Promise<{
  commits: GitCommitDto[];
  root: string;
  error?: string;
}> {
  const root = resolveGovernanceRoot();
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      root,
      "log",
      `--pretty=format:%h|%an|%ci|%s`,
      "-n",
      String(limit),
    ]);
    const commits = stdout
      .split("\n")
      .map((line) => parseGitLogLine(line.trim()))
      .filter((c): c is GitCommit => c !== null)
      .map((c) => ({
        sha: c.sha,
        author: c.author,
        date: c.date.toISOString(),
        message: c.message,
      }));
    return { commits, root };
  } catch (err) {
    return { commits: [], root, error: err instanceof Error ? err.message : String(err) };
  }
}
