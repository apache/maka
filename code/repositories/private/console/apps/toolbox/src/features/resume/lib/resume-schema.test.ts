import { describe, expect, it } from "vitest"
import {
  appearanceSchema,
  entrySchema,
  resumeSchema,
} from "./resume-schema"
import { sampleResume } from "./sample-resume"

describe("resumeSchema", () => {
  it("示例简历通过校验", () => {
    const result = resumeSchema.safeParse(sampleResume)
    expect(result.success).toBe(true)
  })

  it("姓名为空时校验失败", () => {
    const bad = structuredClone(sampleResume)
    bad.profile.name = ""
    expect(resumeSchema.safeParse(bad).success).toBe(false)
  })

  it("条目标题为空时校验失败", () => {
    const result = entrySchema.safeParse({
      id: "x",
      title: "",
      subtitle: "",
      location: "",
      startDate: "",
      endDate: "",
      body: "",
    })
    expect(result.success).toBe(false)
  })

  it("缺省字段自动填充默认值", () => {
    const result = resumeSchema.safeParse({
      profile: { name: "张三" },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.work).toEqual([])
      expect(result.data.sectionOrder).toContain("work")
    }
  })
})

describe("appearanceSchema", () => {
  it("默认值符合约束", () => {
    const a = appearanceSchema.parse({})
    expect(a.themeId).toBe("graphite")
    expect(a.fontSize).toBeGreaterThanOrEqual(11)
    expect(a.fitToOnePage).toBe(true)
  })

  it("字号越界时校验失败", () => {
    expect(appearanceSchema.safeParse({ fontSize: 30 }).success).toBe(false)
  })
})
