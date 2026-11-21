import { describe, expect, it } from "vitest"
import { migrateV1toV2, makeDoc, upgradeAppearance } from "./resume-collection"
import { appearanceSchema, resumeSchema } from "./resume-schema"
import { sampleResume } from "./sample-resume"

describe("upgradeAppearance（v2→v3 外观校准迁移）", () => {
  it("旧默认值（13/1.6/44）升级为紧凑新默认（12.5/1.5/48）", () => {
    const upgraded = upgradeAppearance({ themeId: "graphite", fontSize: 13, lineHeight: 1.6, pagePadding: 44 })
    expect(upgraded.fontSize).toBe(12.5)
    expect(upgraded.lineHeight).toBe(1.5)
    expect(upgraded.pagePadding).toBe(48)
  })

  it("用户自定义值原样保留，新增字段补默认", () => {
    const upgraded = upgradeAppearance({ themeId: "graphite", fontSize: 15.5, lineHeight: 1.8, pagePadding: 60 })
    expect(upgraded.fontSize).toBe(15.5)
    expect(upgraded.lineHeight).toBe(1.8)
    expect(upgraded.pagePadding).toBe(60)
    expect(upgraded.nameInline).toBe(true)
  })
})

const validV1 = () => ({
  resume: resumeSchema.parse({
    profile: { name: "关天豪", headline: "前端开发工程师" },
    summary: "总结",
    work: [],
    projects: [],
    education: [],
    skills: [],
    custom: [],
  }),
  appearance: appearanceSchema.parse({ themeId: "ink-blue" }),
})

describe("migrateV1toV2（单份 → 多份集合）", () => {
  it("合法 v1 数据迁移为单文档集合，activeId 指向它", () => {
    const { docs, activeId } = migrateV1toV2(validV1())
    expect(docs).toHaveLength(1)
    expect(docs[0]!.id).toBe(activeId)
    expect(docs[0]!.resume.profile.name).toBe("关天豪")
    expect(docs[0]!.appearance.themeId).toBe("ink-blue")
    expect(typeof docs[0]!.updatedAt).toBe("number")
  })

  it("文档名默认取「姓名-头衔」", () => {
    const { docs } = migrateV1toV2(validV1())
    expect(docs[0]!.name).toBe("关天豪-前端开发工程师")
  })

  it("损坏/缺失数据回落示例稿，绝不产生空集合", () => {
    const cases: unknown[] = [undefined, {}, { resume: "垃圾" }, null]
    for (const payload of cases) {
      const { docs, activeId } = migrateV1toV2(payload)
      expect(docs).toHaveLength(1)
      expect(docs[0]!.id).toBe(activeId)
      expect(docs[0]!.resume.profile.name).toBe(sampleResume.profile.name)
    }
  })

  it("损坏外观回落默认外观，内容仍然保留", () => {
    const payload = { resume: validV1().resume, appearance: { themeId: 42 } }
    const { docs } = migrateV1toV2(payload)
    expect(docs[0]!.resume.profile.name).toBe("关天豪")
    expect(docs[0]!.appearance.themeId).toBe("graphite")
  })
})

describe("makeDoc 命名规则", () => {
  it("显式名优先", () => {
    const doc = makeDoc(sampleResume, appearanceSchema.parse({}), "  内推专用  ")
    expect(doc.name).toBe("内推专用")
  })

  it("空名回落「姓名-头衔」（schema 保证姓名非空）", () => {
    expect(makeDoc(sampleResume, appearanceSchema.parse({}), "  ").name).toBe(
      [sampleResume.profile.name, sampleResume.profile.headline].filter(Boolean).join("-"),
    )
    const noHeadline = resumeSchema.parse({
      ...sampleResume,
      profile: { ...sampleResume.profile, headline: "" },
    })
    expect(makeDoc(noHeadline, appearanceSchema.parse({})).name).toBe(sampleResume.profile.name)
  })
})
