import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("./sync-content.mjs", import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "gym-sync-"));
  roots.push(root);
  const app = path.join(root, "code/repositories/private/console");
  const scriptRel = "apps/agent/src/features/interview-gym/scripts/sync-content.mjs";
  const content = path.join(app, "apps/agent/public/interview-gym/content");
  const source = path.join(root, "code/paused/interview");
  mkdirSync(path.dirname(path.join(app, scriptRel)), { recursive: true });
  cpSync(script, path.join(app, scriptRel));
  const docs = [
    "03-题库与系统设计/00-P0-必背.md",
    "03-题库与系统设计/04-综合模拟面试/README.md",
    "01-AI项目与Agent工程/00-AI项目地图.md",
    "06-三旗舰作品集加固/01-qoder-proxy-api-叙事与十问.md",
  ];
  for (const file of docs) {
    const target = path.join(source, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `正文 ${file}`);
  }
  const run = (useDefaultSource = false) =>
    spawnSync(process.execPath, [path.join(app, scriptRel)], {
      env: { ...process.env, INTERVIEW_DOCS_DIR: useDefaultSource ? undefined : source },
      encoding: "utf8",
    });
  return { content, source, docs, run };
}

it("当前资料无需候选题库即可同步，包含合并模拟稿和公开项目正文", () => {
  const { content, docs, run } = setup();
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  for (const file of docs)
    expect(readFileSync(path.join(content, file), "utf8")).toBe(`正文 ${file}`);
  expect(JSON.parse(readFileSync(path.join(content, "manifest.json"), "utf8"))).toEqual({
    bank: [docs[0]],
    candidate: [],
    mock: [docs[1]],
    project: [docs[2], docs[3]],
  });
});

it.each(["missing", "empty"])("必需资料目录无效（%s）时退出并保留上一次副本", (mode) => {
  const { content, source, run } = setup();
  const projects = path.join(source, "01-AI项目与Agent工程");
  rmSync(projects, { recursive: true });
  if (mode === "empty") mkdirSync(projects);
  mkdirSync(content, { recursive: true });
  const previous = path.join(content, "previous.md");
  writeFileSync(previous, "上一次成功同步的正文");
  expect(run().status).toBe(1);
  expect(readFileSync(previous, "utf8")).toBe("上一次成功同步的正文");
});

it("未设置来源环境变量时，从 code/paused/interview 同步资料", () => {
  const { content, docs, run } = setup();
  const result = run(true);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(path.join(content, docs[0]), "utf8")).toBe(`正文 ${docs[0]}`);
});
