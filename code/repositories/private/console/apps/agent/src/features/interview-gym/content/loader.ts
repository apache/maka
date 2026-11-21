import { parseBankSection, splitDoc } from "./parse";
import type { BankSection, DocMeta, MockDoc, ProjectCard } from "./types";

// md 是唯一真相源（真相在 interview 仓库）：sync-content 把文档拷进 apps/agent/public/interview-gym/
// 并生成 manifest.json（四组文件清单）。六期并入适配：原 Vite import.meta.glob('?raw') 改为
// 运行时 fetch 静态资源，loadContent 契约不变；改了 interview 的 md 先重跑 sync-content。
const CONTENT_BASE = "/interview-gym/content";

// ponytail: 保留既有路由，五个入口共用唯一合并稿，不重新拆成五份正文。
const mockSlugs = ["基础能力面试", "AI项目深挖", "系统设计面试", "实战编码面试", "综合与HR面试"];

interface ContentManifest {
  bank: string[];
  candidate: string[];
  mock: string[];
  project: string[];
}

function groupLoader(files: string[]): Record<string, () => Promise<string>> {
  const loaders: Record<string, () => Promise<string>> = {};
  for (const rel of files) {
    loaders[`${CONTENT_BASE}/${rel}`] = () =>
      fetch(`${CONTENT_BASE}/${rel}`).then((res) => {
        if (!res.ok) throw new Error(`内容加载失败 HTTP ${res.status}：${rel}`);
        return res.text();
      });
  }
  return loaders;
}

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

function slugOf(file: string): string {
  return file.replace(/\.md$/, "").replace(/^\d+-/, "");
}

function sortedEntries(
  loaders: Record<string, () => Promise<string>>,
): [string, () => Promise<string>][] {
  return Object.entries(loaders).sort(([a], [b]) => a.localeCompare(b));
}

export interface Content {
  bank: BankSection[];
  mocks: MockDoc[];
  projectDocs: DocMeta[];
  projectBodies: Record<string, string>; // slug → markdown 全文
  projectCards: ProjectCard[]; // 来自项目地图的主讲、备用与按需项目
}

let contentPromise: Promise<Content> | null = null;

// 全站共享一份内容快照；内容变更后刷新页面即重拉（静态资源 + 浏览器缓存按文件名失效由 Next 处理）
export function loadContent(): Promise<Content> {
  contentPromise ??= (async () => {
    const res = await fetch(`${CONTENT_BASE}/manifest.json`);
    if (!res.ok) throw new Error(`内容清单加载失败 HTTP ${res.status}，先跑 sync-content`);
    const manifest = (await res.json()) as ContentManifest;
    const bankLoaders = groupLoader(manifest.bank);
    const candidateLoaders = groupLoader(manifest.candidate);
    const mockLoaders = groupLoader(manifest.mock);
    const projectLoaders = groupLoader(manifest.project);

    const bank: BankSection[] = [];
    for (const [path, load] of sortedEntries(bankLoaders)) {
      bank.push(parseBankSection(fileName(path), await load()));
    }
    for (const [path, load] of sortedEntries(candidateLoaders)) {
      bank.push(parseBankSection(fileName(path), await load(), true));
    }

    const mocks: MockDoc[] = [];
    for (const [path, load] of sortedEntries(mockLoaders)) {
      const file = fileName(path);
      const { title, body } = splitDoc(await load(), file);
      for (const slug of mockSlugs) mocks.push({ slug, title, file, body });
    }

    const projectDocs: DocMeta[] = [];
    const projectBodies: Record<string, string> = {};
    for (const [path, load] of sortedEntries(projectLoaders)) {
      const file = fileName(path);
      const { title, body } = splitDoc(await load(), file);
      projectDocs.push({ slug: slugOf(file), title, file });
      projectBodies[slugOf(file)] = body;
    }

    // 表格与旧列表都沿用 [Pxx 名称](正文.md)，跨目录链接取文件名生成 slug。
    const mapRaw = projectBodies["AI项目地图"] ?? "";
    const projectCards: ProjectCard[] = [];
    for (const m of mapRaw.matchAll(/\[(P\d+)\s+(.+?)\]\((.+?\.md)\)/g)) {
      projectCards.push({ code: m[1], name: m[2].trim(), slug: slugOf(fileName(m[3])) });
    }

    return { bank, mocks, projectDocs, projectBodies, projectCards };
  })();
  return contentPromise;
}
