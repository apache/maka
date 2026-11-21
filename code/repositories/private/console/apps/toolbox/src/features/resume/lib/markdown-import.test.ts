import { describe, expect, it } from "vitest"
import { markdownToResume, normalizeMd, resumeToMarkdown } from "./markdown"
import { resumeSchema } from "./resume-schema"
import { sampleResume } from "./sample-resume"

describe("normalizeMd（导入空行规范）", () => {
  it("行尾空白剔除、3+ 空行压成 1 个空行、首尾修剪", () => {
    expect(normalizeMd("a  \n\n\n\nb   \n")).toBe("a\n\nb")
  })
})

describe("markdownToResume（导出的逆变换）", () => {
  it("样例简历 导出→导入 round-trip 保留内容", () => {
    const md = resumeToMarkdown(sampleResume)
    const back = markdownToResume(md)
    // id/links 为生成物；badge 是结构化扩展，md 纯文本格式不承载（已知有损项）
    const stripIds = (r: ReturnType<typeof markdownToResume>) =>
      JSON.parse(
        JSON.stringify(r, (k, v) => (k === "id" || k === "links" || k === "badge" ? undefined : v)),
      )
    // 隐藏章节导出后即"不存在"，两种表达（hiddenSections vs 不在 sectionOrder）语义等价
    const effective = (r: ReturnType<typeof markdownToResume>) => {
      const x = stripIds(r)
      return {
        ...x,
        sectionOrder: (x.sectionOrder as string[]).filter(
          (k) => !(x.hiddenSections as string[]).includes(k),
        ),
        hiddenSections: undefined,
      }
    }
    const source = effective(resumeSchema.parse(sampleResume))
    expect(effective(back)).toEqual(source)
  })

  it("联系方式按特征归类（邮箱/网址/电话/地点）", () => {
    const md = [
      "# 张三",
      "> 后端工程师",
      "13800138000 | zhangsan@example.com | https://z3.dev | 上海",
      "## 工作经历",
      "### 某公司",
      "后端开发 · 上海",
      "2020-01 - 2023-06",
      "- 负责 X",
    ].join("\n")
    const r = markdownToResume(md)
    expect(r.profile.phone).toBe("13800138000")
    expect(r.profile.email).toBe("zhangsan@example.com")
    expect(r.profile.website).toBe("https://z3.dev")
    expect(r.profile.location).toBe("上海")
    expect(r.work[0]).toMatchObject({
      title: "某公司",
      subtitle: "后端开发",
      location: "上海",
      startDate: "2020-01",
      endDate: "2023-06",
    })
    expect(r.work[0]!.body).toBe("- 负责 X")
  })

  it("技能行解析为分组，未知章节落入自定义模块", () => {
    const md = [
      "# 李四",
      "## 技能特长",
      "- **前端**：React、Vue",
      "## 兴趣爱好",
      "摄影、骑行",
    ].join("\n")
    const r = markdownToResume(md)
    expect(r.skills).toHaveLength(1)
    expect(r.skills[0]).toMatchObject({ name: "前端", keywords: ["React", "Vue"] })
    expect(r.custom).toHaveLength(1)
    expect(r.custom[0]).toMatchObject({ name: "兴趣爱好", body: "摄影、骑行" })
    expect(r.sectionOrder).toContain("skills")
    expect(r.sectionOrder).toContain("custom")
  })

  it("缺少 ## 章节的垃圾输入抛错", () => {
    expect(() => markdownToResume("只是一段普通文本")).toThrow(/无法从 Markdown 识别/)
  })
})
