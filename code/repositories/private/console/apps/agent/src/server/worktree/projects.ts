/**
 * worktree 域项目与 Agent 管理（persistence.rs + commands/{project,agent}.rs 降栈）
 * 持久化：data/worktree-projects.json（原 dirs::config_dir/ai-worktree-commander 等价，CONSOLE_DATA_DIR 注入）
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as git from "./git";

interface ProjectRec {
  id: string;
  name: string;
  projectPath: string; // Rust 侧叫 path，JSON 键保持 path
  baseBranch: string;
}

interface AgentRec {
  id: string;
  name: string;
  branch: string;
  agentPath: string; // JSON 键 path
  projectId: string;
}

interface AppData {
  projects: ProjectRec[];
  agents: AgentRec[];
}

const g = globalThis as typeof globalThis & { __wtDataFile?: string };

function dataFile(): string {
  if (g.__wtDataFile) return g.__wtDataFile;
  const dataDir = process.env.CONSOLE_DATA_DIR
    ? path.resolve(process.env.CONSOLE_DATA_DIR)
    : path.resolve(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  g.__wtDataFile = path.join(dataDir, "worktree-projects.json");
  return g.__wtDataFile;
}

/** 测试注入数据文件路径 */
export function setDataFile(p: string): void {
  g.__wtDataFile = p;
}

function readData(): AppData {
  const f = dataFile();
  if (!fs.existsSync(f)) return { projects: [], agents: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf-8")) as Partial<AppData>;
    // 兼容 Rust 侧字段名（path）
    return {
      projects: (raw.projects ?? []).map((x) => ({
        id: x.id, name: x.name, projectPath: (x as unknown as { projectPath?: string }).projectPath ?? (x as unknown as { path: string }).path, baseBranch: x.baseBranch ?? (x as unknown as { base_branch?: string }).base_branch ?? "main",
      })),
      agents: (raw.agents ?? []).map((x) => ({
        id: x.id, name: x.name, branch: x.branch, projectId: x.projectId ?? (x as unknown as { project_id?: string }).project_id ?? "", agentPath: (x as unknown as { agentPath?: string }).agentPath ?? (x as unknown as { path: string }).path,
      })),
    };
  } catch {
    return { projects: [], agents: [] };
  }
}

function writeData(data: AppData): void {
  // 输出保持 Rust 侧字段名（path/base_branch/project_id），跨端互通
  fs.writeFileSync(
    dataFile(),
    JSON.stringify(
      {
        projects: data.projects.map((p) => ({ id: p.id, name: p.name, path: p.projectPath, base_branch: p.baseBranch })),
        agents: data.agents.map((a) => ({ id: a.id, name: a.name, branch: a.branch, path: a.agentPath, project_id: a.projectId })),
      },
      null,
      2,
    ),
    "utf-8",
  );
}

// ---------- 前端 Zod 契约形态 ----------

export interface ProjectView {
  id: string;
  name: string;
  path: string;
  branch: string;
  status: "Clean" | "Dirty" | "unknown";
}

export interface AgentView {
  id: string;
  name: string;
  branch: string;
  path: string;
  projectId: string;
}

// ---------- 项目命令（project.rs） ----------

export async function projectList(): Promise<ProjectView[]> {
  const data = readData();
  return Promise.all(
    data.projects.map(async (p) => {
      try {
        return {
          id: p.id, name: p.name, path: p.projectPath,
          branch: await git.getBranch(p.projectPath),
          status: (await git.isClean(p.projectPath)) ? "Clean" : "Dirty",
        } satisfies ProjectView;
      } catch {
        return { id: p.id, name: p.name, path: p.projectPath, branch: "", status: "unknown" as const };
      }
    }),
  );
}

export async function projectAdd(input: { name: string; projectPath: string }): Promise<ProjectView> {
  const p = input.projectPath;
  if (!git.isGitRepo(p)) throw new Error(`不是 git 仓库: ${p}`);
  const data = readData();
  if (data.projects.some((x) => x.projectPath === p)) throw new Error("项目已存在");
  const rec: ProjectRec = {
    id: randomUUID(),
    name: input.name,
    projectPath: p,
    baseBranch: await git.getBranch(p),
  };
  data.projects.push(rec);
  writeData(data);
  return {
    id: rec.id, name: rec.name, path: rec.projectPath,
    branch: rec.baseBranch, status: (await git.isClean(p)) ? "Clean" : "Dirty",
  };
}

export function projectRemove(projectId: string): boolean {
  const data = readData();
  const before = data.projects.length;
  data.projects = data.projects.filter((x) => x.id !== projectId);
  data.agents = data.agents.filter((x) => x.projectId !== projectId); // 级联清理
  writeData(data);
  return data.projects.length < before;
}

export async function projectStatus(projectId: string): Promise<{ branch: string; status: "Clean" | "Dirty" | "unknown" }> {
  const data = readData();
  const p = data.projects.find((x) => x.id === projectId);
  if (!p) throw new Error(`项目不存在: ${projectId}`);
  try {
    return { branch: await git.getBranch(p.projectPath), status: (await git.isClean(p.projectPath)) ? "Clean" : "Dirty" };
  } catch {
    return { branch: "", status: "unknown" };
  }
}

export async function projectPull(projectId: string): Promise<{ success: boolean; message: string }> {
  const data = readData();
  const p = data.projects.find((x) => x.id === projectId);
  if (!p) throw new Error(`项目不存在: ${projectId}`);
  try {
    const out = await git.pull(p.projectPath);
    return { success: true, message: out.trim() || "已拉取" };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- Agent 命令（agent.rs） ----------

/** agents 目录：数据根下 worktree-agents/<projectId>/<agentName> */
function agentsBaseDir(projectId: string): string {
  const dataDir = process.env.CONSOLE_DATA_DIR
    ? path.resolve(process.env.CONSOLE_DATA_DIR)
    : path.resolve(process.cwd(), "data");
  return path.join(dataDir, "worktree-agents", projectId);
}

export async function agentList(projectId?: string): Promise<AgentView[]> {
  const data = readData();
  return data.agents
    .filter((a) => !projectId || a.projectId === projectId)
    .map((a) => ({ id: a.id, name: a.name, branch: a.branch, path: a.agentPath, projectId: a.projectId }));
}

export async function agentSpawn(input: { projectId: string; agentName: string }): Promise<AgentView> {
  const data = readData();
  const p = data.projects.find((x) => x.id === input.projectId);
  if (!p) throw new Error(`项目不存在: ${input.projectId}`);
  if (data.agents.some((a) => a.projectId === input.projectId && a.name === input.agentName)) {
    throw new Error(`同名 Agent 已存在: ${input.agentName}`);
  }

  const branchName = `agent/${input.agentName}`;
  const worktreePath = path.join(agentsBaseDir(input.projectId), input.agentName);

  // 原版链：确保分支 → 创建 worktree
  if (!git.branchExists(p.projectPath, branchName)) {
    await git.createBranch(p.projectPath, branchName);
  }
  await git.createWorktree(p.projectPath, worktreePath, branchName);

  const rec: AgentRec = {
    id: randomUUID(),
    name: input.agentName,
    branch: branchName,
    agentPath: worktreePath,
    projectId: input.projectId,
  };
  data.agents.push(rec);
  writeData(data);
  return { id: rec.id, name: rec.name, branch: rec.branch, path: rec.agentPath, projectId: rec.projectId };
}

function findAgent(agentId: string): { agent: AgentRec; project: ProjectRec } {
  const data = readData();
  const agent = data.agents.find((x) => x.id === agentId);
  if (!agent) throw new Error(`Agent 不存在: ${agentId}`);
  const project = data.projects.find((x) => x.id === agent.projectId);
  if (!project) throw new Error(`Agent 所属项目不存在: ${agent.projectId}`);
  return { agent, project };
}

export async function agentSyncFromMain(agentId: string): Promise<{ success: boolean; message: string }> {
  const { agent, project } = findAgent(agentId);
  try {
    const out = await git.syncFromMain(agent.agentPath, project.baseBranch);
    return { success: true, message: out.trim() || "已从主分支同步" };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function agentMergeToMain(agentId: string): Promise<{ success: boolean; message: string }> {
  const { agent, project } = findAgent(agentId);
  try {
    const out = await git.mergeToMain(project.projectPath, agent.branch, project.baseBranch);
    return { success: true, message: out.trim() || "已合并到主分支" };
  } catch (e) {
    return { success: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function agentRemove(agentId: string): Promise<boolean> {
  const { agent, project } = findAgent(agentId);
  try {
    await git.removeWorktree(project.projectPath, agent.agentPath);
    await git.deleteBranch(project.projectPath, agent.branch);
  } catch (e) {
    // worktree 已不存在时仍继续清理记录
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("not a working tree") && !msg.includes("does not exist")) throw e;
  }
  const data = readData();
  data.agents = data.agents.filter((x) => x.id !== agentId);
  writeData(data);
  return true;
}

export async function agentRecentCommits(agentId: string, count = 10) {
  const { agent } = findAgent(agentId);
  return git.getRecentCommits(agent.agentPath, count);
}

export async function agentDiffStat(agentId: string): Promise<string> {
  const { agent } = findAgent(agentId);
  return git.getDiffStat(agent.agentPath);
}
