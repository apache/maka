import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "diffmap-review-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("-c", "init.defaultBranch=main", "init");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(dir, "a.txt"), "a original\n");
  writeFileSync(join(dir, "b.txt"), "b original\n");
  git("add", ".");
  git("commit", "-m", "base");
  return { dir, git };
}

async function pass(page: Page, path: string) {
  await page.getByPlaceholder("搜索文件…（回车跳转）").fill(path);
  await page.getByPlaceholder("搜索文件…（回车跳转）").press("Enter");
  await page.getByRole("button", { name: "通过 1", exact: true }).click();
}

test("刷新保持未变化文件的通过标记，只使变化文件失效", async ({ page }) => {
  const { dir } = repo();
  try {
    writeFileSync(join(dir, "a.txt"), "a first\n");
    writeFileSync(join(dir, "b.txt"), "b first\n");
    await page.goto(`/diffmap?${new URLSearchParams({ repo: dir })}`);
    await pass(page, "a.txt");
    await pass(page, "b.txt");
    await expect(page.locator(".cover")).toContainText("通过 2/2");
    await page.getByRole("button", { name: "↻ 刷新", exact: true }).click();
    await expect(page.locator(".cover")).toContainText("通过 2/2");
    await page.reload();
    await expect(page.locator(".cover")).toContainText("通过 2/2");
    writeFileSync(join(dir, "a.txt"), "a second\n");
    await page.getByRole("button", { name: "↻ 刷新", exact: true }).click();
    await expect(page.locator(".cover")).toContainText("通过 1/2");
    await expect(page.locator(".tm-cell").filter({ hasText: "a.txt" })).not.toHaveClass(/st-pass/);
    await expect(page.locator(".tm-cell").filter({ hasText: "b.txt" })).toHaveClass(/st-pass/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("相同大小的二进制内容变化使通过标记失效", async ({ page }) => {
  const { dir, git } = repo();
  try {
    writeFileSync(join(dir, "image.bin"), Buffer.from([0, 1, 2]));
    git("add", ".");
    git("commit", "-m", "binary base");
    writeFileSync(join(dir, "image.bin"), Buffer.from([0, 3, 4]));
    await page.goto(`/diffmap?${new URLSearchParams({ repo: dir })}`);
    await pass(page, "image.bin");
    await expect(page.locator(".cover")).toContainText("通过 1/1");
    await page.waitForTimeout(400);
    await page.reload();
    await expect(page.locator(".cover")).toContainText("通过 1/1");
    writeFileSync(join(dir, "image.bin"), Buffer.from([0, 5, 6]));
    await page.getByRole("button", { name: "↻ 刷新", exact: true }).click();
    await expect(page.locator(".cover")).toContainText("通过 0/1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("实际 CLI 的 --base 传入报告 API，缺引用时失败", async ({ request }) => {
  const { dir, git } = repo();
  const cli = new URL("../../cli/src/index.ts", import.meta.url);
  const tsx = new URL("../../cli/node_modules/.bin/tsx", import.meta.url);
  const run = (...args: string[]) =>
    execFileSync(fileURLToPath(tsx), [fileURLToPath(cli), "diffmap", dir, "--no-open", ...args], {
      encoding: "utf8",
      env: { ...process.env, DIFFMAP_AGENT_BASE: "http://localhost:65504" },
    });
  const report = async (...args: string[]) => {
    const output = run(...args);
    const url = new URL(output.match(/https?:\/\/\S+/)![0]);
    url.pathname = "/api/diffmap/report";
    const response = await request.get(url.toString());
    expect(response.status()).toBe(200);
    return response.json();
  };
  try {
    git("checkout", "-b", "feature");
    writeFileSync(join(dir, "a.txt"), "committed feature\n");
    git("commit", "-am", "feature");
    expect((await report()).files).toEqual([]);
    for (const args of [["--base", "main"], ["--base=main"]]) {
      const result = await report(...args);
      expect(result.mode).toBe("base");
      expect(result.files.map((f: { path: string }) => f.path)).toEqual(["a.txt"]);
    }
    for (const args of [["--base"], ["--base="], ["--base", "--no-open"]]) {
      expect(() => run(...args)).toThrow();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("未提供内容指纹的脏子模块刷新时不复用通过标记", async ({ page }) => {
  const parent = repo();
  const child = repo();
  try {
    parent.git("-c", "protocol.file.allow=always", "submodule", "add", child.dir, "sub");
    parent.git("commit", "-am", "submodule");
    writeFileSync(join(parent.dir, "sub/a.txt"), "dirty first\n");
    await page.goto(`/diffmap?${new URLSearchParams({ repo: parent.dir })}`);
    await pass(page, "sub");
    await expect(page.locator(".cover")).toContainText("通过 1/1");
    await page.waitForTimeout(400);
    writeFileSync(join(parent.dir, "sub/a.txt"), "dirty second\n");
    await page.getByRole("button", { name: "↻ 刷新", exact: true }).click();
    await expect(page.locator(".cover")).toContainText("通过 0/1");
  } finally {
    rmSync(parent.dir, { recursive: true, force: true });
    rmSync(child.dir, { recursive: true, force: true });
  }
});
