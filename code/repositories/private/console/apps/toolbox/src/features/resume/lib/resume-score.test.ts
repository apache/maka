import { describe, expect, it } from "vitest"
import { scoreResume } from "./resume-score"
import { resumeSchema } from "./resume-schema"
import { sampleResume } from "./sample-resume"

const quantRichResume = () =>
  resumeSchema.parse({
    ...sampleResume,
    profile: { ...sampleResume.profile, phone: "138", headline: "前端", location: "杭州" },
    summary: "前端工程师，五年经验，深耕 React 体系与工程化治理。",
    work: [
      {
        id: "w1",
        title: "某公司",
        subtitle: "前端工程师",
        location: "杭州",
        startDate: "2021",
        endDate: "2024",
        body: "- 主导首屏优化，LCP 下降 60%\n- 搭建监控体系，定位时间缩短 90%",
      },
    ],
    projects: [],
    education: [],
    custom: [],
    hiddenSections: [],
    sectionOrder: ["summary", "work", "skills"],
  })

describe("scoreResume（五维质量分）", () => {
  it("量化充分的简历得高分（≥80 优）", () => {
    const s = scoreResume(quantRichResume())
    expect(s.total).toBeGreaterThanOrEqual(80)
    expect(s.grade).toBe("优")
    expect(s.dimensions).toHaveLength(5)
  })

  it("示例骨架稿（待补充文案）得低分并给出改进建议", () => {
    const s = scoreResume(sampleResume)
    expect(s.total).toBeLessThan(80)
    const quantify = s.dimensions.find((d) => d.key === "quantify")
    expect(quantify?.advice).toContain("量化")
  })

  it("篇幅维度：多页扣分", () => {
    const one = scoreResume(quantRichResume(), { pages: 1 })
    const three = scoreResume(quantRichResume(), { pages: 3 })
    const len = (s: ReturnType<typeof scoreResume>) => s.dimensions.find((d) => d.key === "length")!.score
    expect(len(three)).toBeLessThan(len(one))
  })
})
