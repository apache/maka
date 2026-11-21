import { describe, expect, it } from "vitest"
import { extractJdKeywords, matchResumeToJd } from "./jd-match"

const JD = `
岗位职责：
1. 负责公司核心业务 Web 前端开发，使用 React + TypeScript 技术栈
2. 使用 Next.js 完成 SSR 改造，优化首屏加载性能
3. 参与组件库与设计系统建设
4. 使用 Docker 配合 CI/CD 流水线交付
任职要求：
- 熟悉 Node.js、Vite、单元测试
- 了解 WebSocket 与大模型应用落地
`

describe("extractJdKeywords", () => {
  it("提取命中词并按出现次数排序", () => {
    const kws = extractJdKeywords(JD)
    expect(kws.length).toBeGreaterThan(5)
    const react = kws.find((k) => k.term === "React")
    expect(react?.count).toBeGreaterThanOrEqual(1)
    // Next.js 出现 1 次（URL 里的 nextjs 不算，大小写不敏感但词典词是 Next.js）
    const first = kws[0]!
    expect(first.count).toBeGreaterThanOrEqual(kws[kws.length - 1]!.count)
  })

  it("未命中词典的 JD 返回空数组", () => {
    expect(extractJdKeywords("招会计一名")).toEqual([])
  })
})

describe("matchResumeToJd", () => {
  it("按简历全文判定覆盖并计算覆盖率", () => {
    const kws = extractJdKeywords(JD)
    const resumeText = JSON.stringify({ skills: [{ keywords: ["React", "TypeScript"] }], body: "Next.js SSR" })
    const r = matchResumeToJd(kws, resumeText)
    expect(r.matched).toBeGreaterThanOrEqual(2)
    expect(r.coverage).toBeGreaterThan(0)
    expect(r.coverage).toBeLessThan(100)
    const missing = r.keywords.filter((k) => !k.matched).map((k) => k.term)
    expect(missing).toContain("Docker")
  })

  it("全覆盖时 coverage=100", () => {
    const kws = extractJdKeywords("需要 React")
    const r = matchResumeToJd(kws, "精通 React 的工程师")
    expect(r.coverage).toBe(100)
  })
})
