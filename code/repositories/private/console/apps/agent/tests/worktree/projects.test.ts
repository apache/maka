import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// worktree 域契约：真实 git 临时仓全链（project CRUD → agent spawn(worktree) → sync/merge → commits/diff → remove）。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-wt-test-"));
const repo = path.join(tmp, "repo");
const dataFile = path.join(tmp, "wt-data.json");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd }).toString();
}

beforeAll(async () => {
  // 建真实仓库：两个提交 + main 分支
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "v1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  fs.writeFileSync(path.join(repo, "a.txt"), "v2");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "second");

  process.env.CONSOLE_DATA_DIR = tmp;
  const { setDataFile } = await import("@/server/worktree/projects");
  setDataFile(dataFile);
});

afterAll(() => {
  delete process.env.CONSOLE_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("worktree git 能力层（git.rs 16 函数抽样）", () => {
  it("isGitRepo/getBranch/isClean/getStatus/getRecentCommits/getDiffStat", async () => {
    const g = await import("@/server/worktree/git");
    expect(g.isGitRepo(repo)).toBe(true);
    expect(g.isGitRepo(tmp)).toBe(false);
    expect(await g.getBranch(repo)).toBe("main");
    expect(await g.isClean(repo)).toBe(true);
    expect(await g.getStatus(repo)).toContain("On branch");
    const commits = await g.getRecentCommits(repo, 5);
    expect(commits).toHaveLength(2);
    expect(commits[0]!.message).toBe("second");
    expect(await g.getDiffStat(repo)).toBe("");
  });

  it("createBranch/branchExists/deleteBranch 与 worktree 增删/sync/merge", async () => {
    const g = await import("@/server/worktree/git");
    const branch = "agent/t1";
    await g.createBranch(repo, branch);
    expect(g.branchExists(repo, branch)).toBe(true);

    const wtPath = path.join(tmp, "wt-t1");
    await g.createWorktree(repo, wtPath, branch);
    const listed = await g.listWorktrees(repo);
    expect(listed.some(([, b]) => b === branch)).toBe(true);

    // worktree 内提交 → sync from main（无新提交也算成功）→ merge to main
    fs.writeFileSync(path.join(wtPath, "wt.txt"), "from worktree");
    git(wtPath, "add", ".");
    git(wtPath, "commit", "-m", "wt change");
    const sync = await g.syncFromMain(wtPath, "main");
    expect(sync).toBeTruthy();
    const merge = await g.mergeToMain(repo, branch, "main");
    expect(merge).toBeTruthy();
    expect(fs.readFileSync(path.join(repo, "wt.txt"), "utf-8")).toBe("from worktree");

    await g.removeWorktree(repo, wtPath);
    expect(fs.existsSync(wtPath)).toBe(false);
    await g.deleteBranch(repo, branch);
    expect(g.branchExists(repo, branch)).toBe(false);
  });
});

describe("worktree 项目/Agent 命令（13 命令等价）", () => {
  it("project_add/list/status/pull/remove 全链", async () => {
    const m = await import("@/server/worktree/projects");
    m.setDataFile(dataFile);
    const added = await m.projectAdd({ name: "测试仓", projectPath: repo });
    expect(added.status).toBe("Clean");

    const list = await m.projectList();
    expect(list.some((p) => p.id === added.id)).toBe(true);

    const status = await m.projectStatus(added.id);
    expect(status.status).toBe("Clean");

    // 无 remote 的临时仓 git pull 会失败——原版语义：错误包装为 success:false 的 CommandResult 而非抛异常
    const pull = await m.projectPull(added.id);
    expect(typeof pull.success).toBe("boolean");
    expect(typeof pull.message).toBe("string");

    expect(await m.projectRemove(added.id)).toBe(true);
  });

  it("agent_spawn→list→commits/diff→sync→merge→remove 全生命周期", async () => {
    const m = await import("@/server/worktree/projects");
    m.setDataFile(dataFile);
    const p = await m.projectAdd({ name: "主仓", projectPath: repo });

    const agent = await m.agentSpawn({ projectId: p.id, agentName: "worker-a" });
    expect(agent.branch).toBe("agent/worker-a");
    expect(fs.existsSync(agent.path)).toBe(true);
    expect((await m.agentList(p.id)).map((a) => a.name)).toContain("worker-a");

    // worktree 内做改动并提交
    fs.writeFileSync(path.join(agent.path, "agent.txt"), "agent work");
    git(agent.path, "add", ".");
    git(agent.path, "commit", "-m", "agent commit");

    const commits = await m.agentRecentCommits(agent.id, 3);
    expect(commits[0]!.message).toBe("agent commit");
    expect(typeof (await m.agentDiffStat(agent.id))).toBe("string");

    expect((await m.agentSyncFromMain(agent.id)).success).toBe(true);
    expect((await m.agentMergeToMain(agent.id)).success).toBe(true);
    expect(fs.readFileSync(path.join(repo, "agent.txt"), "utf-8")).toBe("agent work");

    expect(await m.agentRemove(agent.id)).toBe(true);
    expect(fs.existsSync(agent.path)).toBe(false);
    await m.projectRemove(p.id);
  });

  it("异常路径：非 git 目录 / 重复项目 / 重复 Agent / 不存在 Agent", async () => {
    const m = await import("@/server/worktree/projects");
    m.setDataFile(dataFile);
    const notRepo = path.join(tmp, "notrepo");
    fs.mkdirSync(notRepo, { recursive: true });
    await expect(m.projectAdd({ name: "bad", projectPath: notRepo })).rejects.toThrow("不是 git 仓库");

    const p = await m.projectAdd({ name: "dup", projectPath: repo });
    await expect(m.projectAdd({ name: "dup2", projectPath: repo })).rejects.toThrow("项目已存在");

    const agent = await m.agentSpawn({ projectId: p.id, agentName: "dup-a" });
    await expect(m.agentSpawn({ projectId: p.id, agentName: "dup-a" })).rejects.toThrow("同名 Agent 已存在");
    await expect(m.agentSyncFromMain("no-such-id")).rejects.toThrow("Agent 不存在");

    await m.agentRemove(agent.id);
    await m.projectRemove(p.id);
  });
});
