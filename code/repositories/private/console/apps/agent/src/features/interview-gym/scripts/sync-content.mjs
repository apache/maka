// 把 interview 仓库（唯一真相源）的题库/模拟卷/项目文档同步进 apps/agent/public/interview-gym/，
// 并生成 manifest.json（题库、模拟说明和项目正文清单）供 features/interview-gym/content/loader.ts 运行时 fetch。
// 内容源可用环境变量 INTERVIEW_DOCS_DIR 指向 interview 仓库根覆盖；默认按本文件位置推算到 code/paused/interview 分区正本。
// 手动跑法：node apps/agent/src/features/interview-gym/scripts/sync-content.mjs

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// <console>/apps/agent/src/features/interview-gym/scripts → console 根要上跳 6 级
const consoleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const publicRoot = path.join(consoleRoot, "apps/agent/public/interview-gym/content");
// 内容源探测：INTERVIEW_DOCS_DIR 显式指定优先；默认按仓布局 <cc>/code/paused/interview
// （2026-11-16 旧 guahub/interview/study 布局随目录收编退役，Mac/Windows 两侧布局一致）
const sourceRoot =
  process.env.INTERVIEW_DOCS_DIR ??
  path.resolve(consoleRoot, "../../../../code/paused/interview");

// 与 loader.ts 的清单一一对应；公开叙事纳入 project，合并说明保留旧模拟入口。
const rules = [
  { key: "bank", dir: "03-题库与系统设计", match: /^0[0-3]-.*\.md$/ },
  { key: "mock", dir: "03-题库与系统设计/04-综合模拟面试", match: /^README\.md$/ },
  { key: "project", dir: "01-AI项目与Agent工程", match: /\.md$/ },
  { key: "project", dir: "06-三旗舰作品集加固", match: /^0[1-3]-.*\.md$/ },
];

if (!existsSync(sourceRoot)) {
  console.error(`[sync-content] 找不到内容源目录：${sourceRoot}`);
  console.error("[sync-content] 请用环境变量 INTERVIEW_DOCS_DIR 指向 interview 仓库根后重试。");
  process.exit(1);
}

// 所有必需来源有效后才更新副本，避免缺源时丢掉上次同步结果。
const sources = rules.map(({ key, dir, match }) => {
  const srcDir = path.join(sourceRoot, dir);
  if (!existsSync(srcDir)) {
    console.error(`[sync-content] 内容源缺少目录：${srcDir}`);
    process.exit(1);
  }
  const files = readdirSync(srcDir)
    .filter((f) => match.test(f))
    .sort();
  if (files.length === 0) {
    console.error(`[sync-content] 内容源目录没有匹配文档：${srcDir}`);
    process.exit(1);
  }
  return { key, dir, files };
});

rmSync(publicRoot, { recursive: true, force: true });
const manifest = { bank: [], candidate: [], mock: [], project: [] };
let total = 0;
for (const { key, dir, files } of sources) {
  const srcDir = path.join(sourceRoot, dir);
  const destDir = path.join(publicRoot, dir);
  mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    cpSync(path.join(srcDir, f), path.join(destDir, f));
    manifest[key].push(path.join(dir, f).replaceAll("\\", "/"));
  }
  total += files.length;
  console.log(`[sync-content] ${key}: ${files.length} 篇 ← ${dir}`);
}
writeFileSync(path.join(publicRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`[sync-content] 共 ${total} 篇 + manifest.json → ${publicRoot}`);
