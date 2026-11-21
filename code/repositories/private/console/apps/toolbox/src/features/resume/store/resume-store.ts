import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  appearanceSchema,
  resumeSchema,
  uid,
  type Appearance,
  type CustomSection,
  type Entry,
  type Resume,
  type SectionKey,
  type SkillGroup,
} from "@/features/resume/lib/resume-schema"
import { sampleResume } from "@/features/resume/lib/sample-resume"
import {
  makeDoc,
  migrateV1toV2,
  pushHistory,
  upgradeAppearance,
  type ResumeDoc,
} from "@/features/resume/lib/resume-collection"

type EntryCollection = "work" | "projects" | "education"

const defaultAppearance = () => appearanceSchema.parse({})

interface ResumeState {
  /** 全部简历文档（至少一份） */
  docs: ResumeDoc[]
  activeId: string
  /** 激活文档镜像：由 mutateActive/switchResume 维护，消费方读这里（保持旧 API） */
  resume: Resume
  appearance: Appearance

  // —— 集合操作 ——
  createResume: (resume?: Resume, name?: string) => string
  duplicateResume: (id: string) => string | undefined
  deleteResume: (id: string) => void
  renameResume: (id: string, name: string) => void
  switchResume: (id: string) => void

  // —— 文档操作（作用于激活文档，签名与旧版一致） ——
  setResume: (resume: Resume) => void
  updateProfile: (patch: Partial<Resume["profile"]>) => void
  updateSummary: (summary: string) => void

  addEntry: (collection: EntryCollection) => void
  updateEntry: (collection: EntryCollection, id: string, patch: Partial<Entry>) => void
  removeEntry: (collection: EntryCollection, id: string) => void
  moveEntry: (collection: EntryCollection, id: string, dir: -1 | 1) => void

  addSkillGroup: () => void
  updateSkillGroup: (id: string, patch: Partial<SkillGroup>) => void
  removeSkillGroup: (id: string) => void

  addCustomSection: () => void
  updateCustomSection: (id: string, patch: Partial<CustomSection>) => void
  removeCustomSection: (id: string) => void

  toggleSection: (key: SectionKey) => void
  moveSection: (key: SectionKey, dir: -1 | 1) => void
  reorderEntry: (collection: EntryCollection, dragId: string, overId: string) => void
  reorderSection: (dragKey: SectionKey, overKey: SectionKey) => void

  takeSnapshot: (label?: string) => void
  restoreSnapshot: (snapshotId: string) => void

  /** 预览实渲染页数（ResumeSheets 上报，非持久化），供质量分篇幅维度用真实值 */
  lastPages: number | null
  setLastPages: (n: number) => void

  updateAppearance: (patch: Partial<Appearance>) => void
  resetAll: () => void
  importJson: (raw: string) => { ok: boolean; error?: string }
}

const initialDoc = makeDoc(sampleResume, defaultAppearance())

const emptyEntry = (): Entry => ({
  id: uid(),
  title: "",
  subtitle: "",
  location: "",
  startDate: "",
  endDate: "",
  body: "",
})

export const useResumeStore = create<ResumeState>()(
  persist(
    (set, get) => {
      /** 对激活文档做变更（变更前自动入快照，30 秒内合并），并同步镜像 */
      const mutateActive = (fn: (doc: ResumeDoc) => ResumeDoc) =>
        set((s) => {
          const docs = s.docs.map((d) => {
            if (d.id !== s.activeId) return d
            return fn(pushHistory(d))
          })
          const active = docs.find((d) => d.id === s.activeId) ?? docs[0]!
          return { docs, resume: active.resume, appearance: active.appearance }
        })

      return {
        docs: [initialDoc],
        activeId: initialDoc.id,
        lastPages: null,
        setLastPages: (n) => set({ lastPages: n }),
        resume: initialDoc.resume,
        appearance: initialDoc.appearance,

        // —— 集合操作 ——

        createResume: (resume, name) => {
          const doc = makeDoc(resume ?? sampleResume, defaultAppearance(), name)
          set((s) => ({ docs: [...s.docs, doc], activeId: doc.id, resume: doc.resume, appearance: doc.appearance }))
          return doc.id
        },

        duplicateResume: (id) => {
          const src = get().docs.find((d) => d.id === id)
          if (!src) return undefined
          const copy: ResumeDoc = {
            ...src,
            id: uid(),
            name: `${src.name} 副本`,
            resume: structuredClone(src.resume),
            appearance: { ...src.appearance },
            updatedAt: Date.now(),
          }
          set((s) => ({ docs: [...s.docs, copy] }))
          return copy.id
        },

        deleteResume: (id) =>
          set((s) => {
            if (s.docs.length <= 1) return s // 至少保留一份
            const docs = s.docs.filter((d) => d.id !== id)
            const activeId = s.activeId === id ? docs[0]!.id : s.activeId
            const active = docs.find((d) => d.id === activeId)!
            return { docs, activeId, resume: active.resume, appearance: active.appearance }
          }),

        renameResume: (id, name) =>
          set((s) => ({
            docs: s.docs.map((d) => (d.id === id ? { ...d, name, updatedAt: Date.now() } : d)),
          })),

        switchResume: (id) =>
          set((s) => {
            const doc = s.docs.find((d) => d.id === id)
            if (!doc) return s
            return { activeId: id, resume: doc.resume, appearance: doc.appearance }
          }),

        // —— 文档操作（激活文档） ——

        setResume: (resume) => mutateActive((d) => ({ ...d, resume, updatedAt: Date.now() })),

        updateProfile: (patch) =>
          mutateActive((d) => ({
            ...d,
            updatedAt: Date.now(),
            resume: { ...d.resume, profile: { ...d.resume.profile, ...patch } },
          })),

        updateSummary: (summary) =>
          mutateActive((d) => ({ ...d, updatedAt: Date.now(), resume: { ...d.resume, summary } })),

        addEntry: (collection) =>
          mutateActive((d) => ({
            ...d,
            updatedAt: Date.now(),
            resume: { ...d.resume, [collection]: [...d.resume[collection], emptyEntry()] },
          })),

        updateEntry: (collection, id, patch) =>
          mutateActive((d) => ({
            ...d,
            updatedAt: Date.now(),
            resume: {
              ...d.resume,
              [collection]: d.resume[collection].map((e) => (e.id === id ? { ...e, ...patch } : e)),
            },
          })),

        removeEntry: (collection, id) =>
          mutateActive((d) => ({
            ...d,
            updatedAt: Date.now(),
            resume: { ...d.resume, [collection]: d.resume[collection].filter((e) => e.id !== id) },
          })),

        moveEntry: (collection, id, dir) =>
          mutateActive((d) => {
            const list = [...d.resume[collection]]
            const i = list.findIndex((e) => e.id === id)
            const j = i + dir
            if (i < 0 || j < 0 || j >= list.length) return d
            ;[list[i], list[j]] = [list[j], list[i]]
            return { ...d, updatedAt: Date.now(), resume: { ...d.resume, [collection]: list } }
          }),

        addSkillGroup: () =>
          mutateActive((d) => ({
            ...d,
            updatedAt: Date.now(),
            resume: { ...d.resume, skills: [...d.resume.skills, { id: uid(), name: "", keywords: [] }] },
          })),

        updateSkillGroup: (id, patch) =>
          mutateActive((d) => ({
            ...d,
            updatedAt: Date.now(),
            resume: {
              ...d.resume,
              skills: d.resume.skills.map((g) => (g.id === id ? { ...g, ...patch } : g)),
            },
          })),

        removeSkillGroup: (id) =>
          mutateActive((d) => ({
            ...d,
            updatedAt: Date.now(),
            resume: { ...d.resume, skills: d.resume.skills.filter((g) => g.id !== id) },
          })),

        addCustomSection: () =>
          mutateActive((d) => ({
            ...d,
            updatedAt: Date.now(),
            resume: {
              ...d.resume,
              custom: [...d.resume.custom, { id: uid(), name: "自定义模块", body: "" }],
              sectionOrder: d.resume.sectionOrder.includes("custom")
                ? d.resume.sectionOrder
                : [...d.resume.sectionOrder, "custom"],
            },
          })),

        updateCustomSection: (id, patch) =>
          mutateActive((d) => ({
            ...d,
            updatedAt: Date.now(),
            resume: {
              ...d.resume,
              custom: d.resume.custom.map((c) => (c.id === id ? { ...c, ...patch } : c)),
            },
          })),

        removeCustomSection: (id) =>
          mutateActive((d) => {
            const custom = d.resume.custom.filter((c) => c.id !== id)
            return {
              ...d,
              updatedAt: Date.now(),
              resume: {
                ...d.resume,
                custom,
                sectionOrder: custom.length
                  ? d.resume.sectionOrder
                  : d.resume.sectionOrder.filter((k) => k !== "custom"),
              },
            }
          }),

        toggleSection: (key) =>
          mutateActive((d) => ({
            ...d,
            updatedAt: Date.now(),
            resume: {
              ...d.resume,
              hiddenSections: d.resume.hiddenSections.includes(key)
                ? d.resume.hiddenSections.filter((k) => k !== key)
                : [...d.resume.hiddenSections, key],
            },
          })),

        moveSection: (key, dir) =>
          mutateActive((d) => {
            const order = [...d.resume.sectionOrder]
            const i = order.indexOf(key)
            const j = i + dir
            if (i < 0 || j < 0 || j >= order.length) return d
            ;[order[i], order[j]] = [order[j], order[i]]
            return { ...d, updatedAt: Date.now(), resume: { ...d.resume, sectionOrder: order } }
          }),

        reorderEntry: (collection, dragId, overId) =>
          mutateActive((d) => {
            const list = [...d.resume[collection]]
            const from = list.findIndex((e) => e.id === dragId)
            const to = list.findIndex((e) => e.id === overId)
            if (from < 0 || to < 0 || from === to) return d
            const [moved] = list.splice(from, 1)
            list.splice(to, 0, moved!)
            return {
              ...d,
              updatedAt: Date.now(),
              resume: { ...d.resume, [collection]: list },
            }
          }),

        reorderSection: (dragKey, overKey) =>
          mutateActive((d) => {
            const order = [...d.resume.sectionOrder]
            const from = order.indexOf(dragKey)
            const to = order.indexOf(overKey)
            if (from < 0 || to < 0 || from === to) return d
            const [moved] = order.splice(from, 1)
            order.splice(to, 0, moved!)
            return {
              ...d,
              updatedAt: Date.now(),
              resume: { ...d.resume, sectionOrder: order },
            }
          }),

        takeSnapshot: (label) => mutateActive((d) => pushHistory(d, label)),

        restoreSnapshot: (snapshotId) =>
          mutateActive((d) => {
            const snap = (d.history ?? []).find((s) => s.id === snapshotId)
            if (!snap) return d
            return {
              ...d,
              resume: structuredClone(snap.resume),
              appearance: { ...snap.appearance },
              updatedAt: Date.now(),
            }
          }),

        updateAppearance: (patch) =>
          mutateActive((d) => ({ ...d, updatedAt: Date.now(), appearance: { ...d.appearance, ...patch } })),

        resetAll: () =>
          mutateActive((d) => ({ ...d, resume: sampleResume, appearance: defaultAppearance(), updatedAt: Date.now() })),

        importJson: (raw) => {
          try {
            const data = JSON.parse(raw)
            // 兼容两种导出格式：裸 resume（旧版）或 { resume, appearance } 打包（新版）
            const direct = resumeSchema.safeParse(data)
            const fromPack = direct.success ? null : resumeSchema.safeParse(data?.resume)
            const resume = direct.success ? direct.data : fromPack?.success ? fromPack.data : null
            if (!resume) {
              return { ok: false, error: "JSON 结构不符合简历数据格式" }
            }
            const appearance = appearanceSchema.safeParse(
              direct.success ? {} : (data?.appearance ?? {}),
            )
            mutateActive((d) => ({
              ...d,
              resume,
              appearance: appearance.success ? appearance.data : d.appearance,
              updatedAt: Date.now(),
            }))
            return { ok: true }
          } catch {
            return { ok: false, error: "不是合法的 JSON 文件" }
          }
        },
      }
    },
    {
      name: "muji-resume",
      version: 3,
      // 只持久化集合层；resume/appearance 镜像由 merge 重建
      partialize: (s) => ({ docs: s.docs, activeId: s.activeId }),
      migrate: (persisted, version) => {
        if (version < 2) {
          const v2 = migrateV1toV2(persisted)
          return { ...v2, docs: v2.docs.map((d) => ({ ...d, appearance: upgradeAppearance(d.appearance) })) }
        }
        const p = persisted as { docs?: ResumeDoc[]; activeId?: string }
        return { ...p, docs: (p.docs ?? []).map((d) => ({ ...d, appearance: upgradeAppearance(d.appearance) })) }
      },
      merge: (persisted, current) => {
        const p = persisted as Partial<Pick<ResumeState, "docs" | "activeId">>
        const docs = p.docs?.length ? p.docs : current.docs
        const activeId = docs.some((d) => d.id === p.activeId) ? p.activeId! : docs[0]!.id
        const active = docs.find((d) => d.id === activeId)!
        return { ...current, docs, activeId, resume: active.resume, appearance: active.appearance }
      },
    },
  ),
)

/** 激活文档（含 name/updatedAt 等集合信息） */
export const useActiveDoc = () =>
  useResumeStore((s) => s.docs.find((d) => d.id === s.activeId) ?? s.docs[0])

/** 选择器：当前可见模块 */
export const useVisibleSections = () =>
  useResumeStore((s) => {
    const doc = s.docs.find((d) => d.id === s.activeId) ?? s.docs[0]
    return doc.resume.sectionOrder.filter((k) => !doc.resume.hiddenSections.includes(k))
  })

export { type ResumeDoc } from "@/features/resume/lib/resume-collection"
export { type EntryCollection }
export const _storeInternals = { get: () => useResumeStore.getState() }
