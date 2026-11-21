import { describe, expect, it } from "vitest"
import { quantifyHints, weakVerbHints } from "./content-review"

describe("quantifyHints（量化缺失检测）", () => {
  it("无数字的 bullet 提示，有量化或短行放过", () => {
    const text = ["- 负责性能优化工作", "- 主导首屏优化，LCP 从 4.2s 降至 1.6s", "- 短"].join("\n")
    const hints = quantifyHints(text)
    expect(hints).toHaveLength(1)
    expect(hints[0]).toMatchObject({ line: 0, excerpt: "负责性能优化工作" })
  })

  it("百分比/倍数/万 都算量化", () => {
    for (const line of ["- 提升复用率 40%", "- 效率提升 3 倍", "  - 服务 10万 用户"]) {
      expect(quantifyHints(line)).toHaveLength(0)
    }
  })
})

describe("weakVerbHints（弱动词检测）", () => {
  it("负责/参与/进行了 命中并给改写公式", () => {
    const text = ["- 负责前端日常开发", "- 参与了架构设计", "- 进行了性能优化", "- 主导缓存体系落地"].join("\n")
    const hints = weakVerbHints(text)
    expect(hints).toHaveLength(3)
    expect(hints[0]!.message).toContain("主导")
    expect(hints[2]!.message).toContain("名词化")
  })

  it("中段含弱词不算（只看开头），非 bullet 不检测", () => {
    expect(weakVerbHints("- 主导并负责全链路")).toHaveLength(0)
    expect(weakVerbHints("负责了很多事")).toHaveLength(0)
  })
})
