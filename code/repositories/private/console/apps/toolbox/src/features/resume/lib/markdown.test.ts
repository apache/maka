import { describe, expect, it } from "vitest"
import { parseInline, parseMarkdown, resumeToMarkdown } from "./markdown"
import { sampleResume } from "./sample-resume"

describe("parseInline", () => {
  it("解析纯文本为单个 segment", () => {
    expect(parseInline("hello")).toEqual([{ text: "hello", bold: false }])
  })

  it("解析 **加粗** 语法", () => {
    expect(parseInline("擅长 **React** 生态")).toEqual([
      { text: "擅长 ", bold: false },
      { text: "React", bold: true },
      { text: " 生态", bold: false },
    ])
  })

  it("支持多段加粗", () => {
    const segments = parseInline("**A** and **B**")
    expect(segments.filter((s) => s.bold).map((s) => s.text)).toEqual(["A", "B"])
  })
})

describe("parseMarkdown", () => {
  it("将以 - 开头的连续行解析为列表", () => {
    const blocks = parseMarkdown("- 第一条\n- 第二条")
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe("list")
    if (blocks[0].type === "list") expect(blocks[0].items).toHaveLength(2)
  })

  it("空行分隔段落与列表", () => {
    const blocks = parseMarkdown("开头段落\n\n- 列表项\n\n结尾段落")
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "list", "paragraph"])
  })

  it("段落内的多行合并为一个段落", () => {
    const blocks = parseMarkdown("第一行\n第二行")
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe("paragraph")
  })
})

describe("resumeToMarkdown", () => {
  it("导出包含姓名与模块标题", () => {
    const md = resumeToMarkdown(sampleResume)
    expect(md).toContain(`# ${sampleResume.profile.name}`)
    expect(md).toContain("## 工作经历")
    expect(md).toContain("## 技能特长")
  })

  it("隐藏的模块不出现在导出中", () => {
    const md = resumeToMarkdown({
      ...sampleResume,
      projects: [{ id: "p1", title: "博客微服务", subtitle: "Next.js", location: "", startDate: "2026.08", endDate: "", body: "- 合并九个项目" }],
      hiddenSections: ["work"],
    })
    expect(md).not.toContain("## 工作经历")
    expect(md).toContain("## 项目经历")
  })

  it("技能组以加粗组名导出", () => {
    const md = resumeToMarkdown(sampleResume)
    expect(md).toContain("- **语言与框架**：TypeScript、React")
  })
})
