import { describe, expect, it } from "vitest"
import { scaffoldBody, scaffoldLabels, summaryLeadLine } from "./content-scaffold"

describe("scaffoldBody（三段式脚手架）", () => {
  it("空 body 生成三段骨架，含 ■ 标题与二级要点", () => {
    const out = scaffoldBody("work", "")
    expect(out).toContain("- ■ **核心挑战**：")
    expect(out).toContain("- ■ **关键设计与实践**：")
    expect(out).toContain("- ■ **结果与影响**：")
    expect(out).toContain("  - ")
  })

  it("已有内容追加不覆盖（空行分隔）", () => {
    const out = scaffoldBody("work", "- 负责老模块")
    expect(out.startsWith("- 负责老模块\n\n- ■ **核心挑战**")).toBe(true)
    expect(out).toContain("- 负责老模块")
  })

  it("project 变体用「背景与目标/技术方案/成效」", () => {
    const out = scaffoldBody("project", "")
    expect(out).toContain("**背景与目标**")
    expect(out).toContain("**技术方案**")
    expect(out).toContain("**成效**")
  })

  it("三类骨架齐备", () => {
    expect(scaffoldLabels).toHaveLength(3)
    expect(summaryLeadLine()).toContain("一句话概述")
  })
})
