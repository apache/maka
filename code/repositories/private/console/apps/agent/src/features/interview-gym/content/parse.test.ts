import { describe, expect, it } from "vitest";
import { parseBankSection, splitDoc, splitTags } from "./parse";

const V2_DOC = `---
title: 测试分区
status: active
---

# 测试分区

引言文字。

## 1. 事件循环

**标签**：JS基础、异步
**难度**：中等
**频次**：高

**回答要点**：先讲清任务队列。
**验收**：举一个反例。

## 2. 闭包

**回答要点**：词法环境。

## 通用追问

这一段是附注。
`;

const LEGACY_DOC = `---
title: 旧格式
---

# 旧格式

## 1. 深拷贝

**回答要点**：JSON 序列化不是通用深拷贝。

**验收**：举失败路径。
`;

describe("parseBankSection", () => {
  it("解析 v2 元数据（标签/难度/频次）", () => {
    const section = parseBankSection("01-测试分区.md", V2_DOC);
    expect(section.id).toBe("测试分区");
    expect(section.candidate).toBe(false);
    const q1 = section.questions[0];
    expect(q1.id).toBe("测试分区/事件循环");
    expect(q1.title).toBe("事件循环");
    expect(q1.tags).toEqual(["JS基础", "异步"]);
    expect(q1.difficulty).toBe("中等");
    expect(q1.frequency).toBe("高");
    expect(q1.points).toContain("任务队列");
    expect(q1.acceptance).toContain("反例");
  });

  it("向后兼容：无元数据的旧题目 tags 为空", () => {
    const section = parseBankSection("02-旧格式.md", LEGACY_DOC);
    const q = section.questions[0];
    expect(q.tags).toEqual([]);
    expect(q.difficulty).toBeUndefined();
    expect(q.points).toContain("JSON");
    expect(q.acceptance).toContain("失败路径");
  });

  it("h1 与 frontmatter 之间隔空行也能剥离", () => {
    const section = parseBankSection("02-旧格式.md", LEGACY_DOC);
    expect(section.intro).not.toContain("# 旧格式");
    expect(section.intro).not.toContain("---");
  });

  it("非编号 ## 小节进入 notes，不混入题目", () => {
    const section = parseBankSection("01-测试分区.md", V2_DOC);
    expect(section.questions).toHaveLength(2);
    expect(section.notes).toHaveLength(1);
    expect(section.notes[0].title).toBe("通用追问");
    expect(section.notes[0].bodyMd).toContain("附注");
  });

  it("候选区标记透传", () => {
    const section = parseBankSection("01-候选.md", V2_DOC, true);
    expect(section.candidate).toBe(true);
  });

  it.each(["F01", "A01", "S01"])("识别 %s 题目并完整提供骨架、失败追问、验收和深挖正文", (code) => {
    const body =
      "**骨架**：请求身份必须匹配当前顾客。\n\n**失败追问**：A 晚于 B 返回怎么办？\n\n**验收**：观察 B 的页面保持不变。\n\n### 深挖案例\n\n检查取消未生效的失败时间线。";
    const section = parseBankSection(
      "00-测试分区.md",
      `---\ntitle: 测试分区\n---\n\n# 测试分区\n\n## ${code} 怎样避免旧响应覆盖？\n\n${body}\n\n## 原理参考\n\n按需查阅。`,
    );
    expect(section.questions).toHaveLength(1);
    expect(section.questions[0].id).toBe("测试分区/怎样避免旧响应覆盖？");
    expect(section.questions[0].points).toBe(body);
    expect(section.notes.map((note) => note.title)).toEqual(["原理参考"]);
  });
});

describe("splitDoc", () => {
  it("去掉 frontmatter 与 h1，保留正文", () => {
    const { title, body } = splitDoc(V2_DOC, "x.md");
    expect(title).toBe("测试分区");
    expect(body).not.toContain("# 测试分区");
    expect(body).toContain("引言文字");
  });
});

describe("splitTags", () => {
  it("支持顿号/逗号/空格分隔", () => {
    expect(splitTags("a、b, c；d e")).toEqual(["a", "b", "c", "d", "e"]);
  });
});
