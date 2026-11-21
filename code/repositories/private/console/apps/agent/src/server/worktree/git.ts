/**
 * worktree 域 git 能力层：git.rs 16 函数忠实降栈为 execFile git。
 * 全部函数语义、参数与输出格式对齐原 Rust 实现。
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(e.stderr?.trim() || e.message);
  }
}

export function isGitRepo(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

export async function getBranch(cwd: string): Promise<string> {
  const out = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  return out.trim();
}

export async function isClean(cwd: string): Promise<boolean> {
  const out = await runGit(["status", "--porcelain"], cwd);
  return out.trim().length === 0;
}

export async function getStatus(cwd: string): Promise<string> {
  return runGit(["status"], cwd);
}

export async function pull(cwd: string): Promise<string> {
  return runGit(["pull"], cwd);
}

export async function createBranch(cwd: string, branchName: string): Promise<string> {
  return runGit(["branch", branchName], cwd);
}

export function branchExists(cwd: string, branchName: string): boolean {
  try {
    // 同步语义对齐原版（spawnSync）；Node 侧用 execFileSync
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function createWorktree(basePath: string, worktreePath: string, branchName: string): Promise<string> {
  return runGit(["worktree", "add", worktreePath, branchName], basePath);
}

export async function removeWorktree(basePath: string, worktreePath: string): Promise<string> {
  return runGit(["worktree", "remove", worktreePath], basePath);
}

export async function deleteBranch(cwd: string, branchName: string): Promise<string> {
  return runGit(["branch", "-D", branchName], cwd);
}

/** list_worktrees --porcelain 解析：[[path, branch], ...] */
export async function listWorktrees(cwd: string): Promise<Array<[string, string]>> {
  const out = await runGit(["worktree", "list", "--porcelain"], cwd);
  const result: Array<[string, string]> = [];
  let currentPath = "";
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length); // refs/heads/xxx
      result.push([currentPath, ref.replace("refs/heads/", "")]);
    }
  }
  return result;
}

/** 从主分支同步（merge main into worktree branch） */
export async function syncFromMain(worktreePath: string, mainBranch: string): Promise<string> {
  return runGit(["merge", mainBranch], worktreePath);
}

/** 合并 agent 分支到主分支（在 base 仓库执行） */
export async function mergeToMain(basePath: string, agentBranch: string, mainBranch: string): Promise<string> {
  await runGit(["checkout", mainBranch], basePath);
  return runGit(["merge", agentBranch], basePath);
}

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/** 最近提交（hash|author|date|message 格式，对齐原 Rust 解析顺序） */
export async function getRecentCommits(cwd: string, count: number): Promise<CommitInfo[]> {
  const out = await runGit(
    ["log", `-${count}`, "--pretty=format:%h|%an|%ad|%s", "--date=iso"],
    cwd,
  );
  if (!out.trim()) return [];
  return out
    .trim()
    .split("\n")
    .map((line) => {
      const [hash, author, date, ...messageParts] = line.split("|");
      return { hash: hash ?? "", author: author ?? "", date: date ?? "", message: messageParts.join("|") };
    });
}

export async function getDiffStat(cwd: string): Promise<string> {
  return runGit(["diff", "--stat"], cwd);
}
