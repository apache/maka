import { frontmatterSchema } from "./types";
import type { BankSection, Question } from "./types";

// 解析 `---` 包裹的扁平 frontmatter，字段校验交给 Zod
function splitFrontmatter(raw: string, file: string): { title: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) throw new Error(`${file}：缺少 frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  const parsed = frontmatterSchema.safeParse(fields);
  if (!parsed.success)
    throw new Error(
      `${file}：frontmatter 校验失败（${parsed.error.issues[0]?.message ?? "未知"}）`,
    );
  return { title: parsed.data.title, body: raw.slice(m[0].length) };
}

// 提取题目内加粗标签段：元数据（标签/难度/频次）+ 主体（回答要点/验收）
const LABEL_RE = /\*\*(回答要点|验收|标签|难度|频次)\*\*[：:]?/g;

export function splitTags(text: string): string[] {
  return text
    .split(/[、,，;；\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function extractParts(
  body: string,
): Pick<Question, "tags" | "difficulty" | "frequency" | "points" | "acceptance"> {
  const hits = [...body.matchAll(LABEL_RE)].map((m) => {
    const at = m.index ?? 0;
    return { label: m[1], start: at, end: at + m[0].length };
  });
  const parts = {
    tags: [] as string[],
    difficulty: undefined,
    frequency: undefined,
    points: "",
    acceptance: "",
  } as Pick<Question, "tags" | "difficulty" | "frequency" | "points" | "acceptance">;
  for (let i = 0; i < hits.length; i++) {
    const text = body
      .slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].start : undefined)
      .trim();
    switch (hits[i].label) {
      case "回答要点":
        parts.points = text;
        break;
      case "验收":
        parts.acceptance = text;
        break;
      case "标签":
        parts.tags = splitTags(text);
        break;
      case "难度":
        parts.difficulty = text;
        break;
      case "频次":
        parts.frequency = text;
        break;
    }
  }
  return parts;
}

// h1 可能与 frontmatter 之间隔一个空行，所以要允许前导空白
const H1_RE = /^\s*#\s+.+?\r?\n/;

// 题库 md 结构：frontmatter + h1 + 引言 + `## N. 题目` 或 `## F/A/S编号 题目`；
// 非编号的 `##` 小节（如系统设计·通用追问）作为 section 笔记保留
export function parseBankSection(file: string, raw: string, candidate = false): BankSection {
  const { title, body } = splitFrontmatter(raw, file);
  const sectionId = file.replace(/\.md$/, "").replace(/^\d+-/, "");

  const stripped = body.replace(H1_RE, "");
  const lines = stripped.split(/\r?\n/);

  const questions: Question[] = [];
  const notes: { title: string; bodyMd: string }[] = [];
  let intro = "";
  let current: { heading: string; body: string[] } | null = null;
  let inIntro = true;

  const flush = () => {
    if (!current) return;
    const bodyText = current.body.join("\n").trim();
    const m = /^(\d+\s*[.、．]\s*|[FAS]\d{2}\s+)(.+)$/.exec(current.heading);
    if (m) {
      const parts = extractParts(bodyText);
      if (/^[FAS]/.test(m[1])) {
        // 当前题卡以完整正文作参考，避免摘要分支隐藏案例、失败追问与深挖。
        parts.points = bodyText;
        parts.acceptance = "";
      }
      questions.push({
        id: `${sectionId}/${m[2].trim()}`,
        sectionId,
        title: m[2].trim(),
        ...parts,
        bodyMd: bodyText,
      });
    } else if (current.heading) {
      notes.push({ title: current.heading, bodyMd: bodyText });
    }
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flush();
      inIntro = false;
      current = { heading: line.slice(3).trim(), body: [] };
    } else if (inIntro) {
      intro += `${line}\n`;
    } else {
      current?.body.push(line);
    }
  }
  flush();

  return { id: sectionId, file, title, intro: intro.trim(), notes, questions, candidate };
}

// 只读文档（项目/模拟卷）用：标题由页面按 frontmatter 渲染，正文去掉 frontmatter 和 h1
export function splitDoc(raw: string, file: string): { title: string; body: string } {
  const { title, body } = splitFrontmatter(raw, file);
  return { title, body: body.replace(H1_RE, "") };
}
