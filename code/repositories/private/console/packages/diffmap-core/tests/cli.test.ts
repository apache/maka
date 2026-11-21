// 自 diffmap src/cli.test.ts（源仓最后的脏区新增）并入：原版 spawn dist/cli.js 起服务的 e2e
// 改为引擎直测——API 路由只是 extractReport 的薄封装，服务语义已随 server.ts 退役。
import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractReport } from "../src/extract.ts";
import { DiffmapCliError, parseDiffmapArgs } from "../src/cli.ts";

it("--base 显示已提交的分支差异，默认模式只显示未提交差异", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diffmap-cli-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  try {
    git("-c", "init.defaultBranch=main", "init");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.invalid");
    writeFileSync(join(dir, "notes.txt"), "base\n");
    git("add", ".");
    git("commit", "-m", "base");
    git("checkout", "-b", "feature");
    writeFileSync(join(dir, "notes.txt"), "feature\n");
    git("commit", "-am", "feature");
    const worktree = await extractReport({ repoRoot: dir, mode: "worktree" });
    expect(worktree.mode).toBe("worktree");
    expect(worktree.files).toEqual([]);
    const base = await extractReport({ repoRoot: dir, mode: "base", baseRef: "main" });
    expect(base.mode).toBe("base");
    expect(base.files.map((file) => file.path)).toEqual(["notes.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("缺少 --base 引用时明确失败，不落入默认模式", () => {
  for (const args of [["--base"], ["--base="], ["--base", "--no-open"]]) {
    expect(() => parseDiffmapArgs(args)).toThrow(DiffmapCliError);
    expect(() => parseDiffmapArgs(args)).toThrow(/--base/);
  }
});

it("--base=main 与 --base main 等价，均强制 base 模式", () => {
  expect(parseDiffmapArgs(["--base", "main"])).toMatchObject({ mode: "base", baseRef: "main" });
  expect(parseDiffmapArgs(["--base=main"])).toMatchObject({ mode: "base", baseRef: "main" });
  expect(parseDiffmapArgs([])).toMatchObject({ mode: "worktree" });
});
