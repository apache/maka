"use client"

import {
  Eye,
  EyeOff,
  GripVertical,
  Plus,
  Trash2,
  WandSparkles,
} from "lucide-react"
import { useRef, useState, type ReactNode } from "react"
import { Button } from "@ggbdpq/console-ui"
import { Input } from "@ggbdpq/console-ui"
import { Label } from "@ggbdpq/console-ui"
import { ScrollArea } from "@ggbdpq/console-ui"
import { Separator } from "@ggbdpq/console-ui"
import { Switch } from "@ggbdpq/console-ui"
import { cn } from "@ggbdpq/console-ui"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ggbdpq/console-ui"
import {
  scaffoldBody,
  scaffoldLabels,
} from "@/features/resume/lib/content-scaffold"
import { BulletLibraryButton } from "@/features/resume/components/editor/BulletLibraryDialog"
import { AiPolishButton } from "@/features/resume/components/editor/AiPolishButton"
import { reviewEntryBody } from "@/features/resume/lib/content-review"

/** body 实时检测提示（R3）：量化缺失 + 弱动词，只提示不强制 */
function BodyHints({ text }: { text: string }) {
  const review = reviewEntryBody(text)
  const hints = [...review.weakVerb, ...review.quantify].slice(0, 3)
  if (hints.length === 0) return null
  return (
    <div className="space-y-1 rounded-md bg-warning/10 px-2.5 py-1.5">
      {hints.map((h, i) => (
        <p key={i} className="text-xs leading-5 text-foreground">
          <span className="mr-1 text-warning">●</span>
          {h.excerpt ? `「${h.excerpt}」` : ""}
          {h.message}
        </p>
      ))}
      {review.quantify.length + review.weakVerb.length > hints.length && (
        <p className="text-[10px] text-muted-foreground">
          还有 {review.quantify.length + review.weakVerb.length - hints.length} 条提示未显示
        </p>
      )}
    </div>
  )
}
import { Textarea } from "@ggbdpq/console-ui"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@ggbdpq/console-ui"
import { type Entry, type SectionKey } from "@/features/resume/lib/resume-schema"
import { useResumeStore, type EntryCollection } from "@/features/resume/store/resume-store"

const SECTION_NAMES: Record<SectionKey, string> = {
  summary: "个人总结",
  work: "工作经历",
  projects: "项目经历",
  education: "教育经历",
  skills: "技能特长",
  custom: "自定义模块",
}

function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function PanelSection({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action}
      </div>
      {children}
      <Separator className="mt-4" />
    </div>
  )
}

function ProfileEditor() {
  const profile = useResumeStore((s) => s.resume.profile)
  const updateProfile = useResumeStore((s) => s.updateProfile)
  const fileRef = useRef<HTMLInputElement>(null)
  const [avatarError, setAvatarError] = useState<string | null>(null)
  return (
    <PanelSection title="基本信息">
      <div className="grid grid-cols-2 gap-3">
        <Field label="姓名">
          <Input
            value={profile.name}
            onChange={(e) => updateProfile({ name: e.target.value })}
            placeholder="你的姓名"
          />
        </Field>
        <Field label="头衔 / 求职意向">
          <Input
            value={profile.headline}
            onChange={(e) => updateProfile({ headline: e.target.value })}
            placeholder="高级前端工程师"
          />
        </Field>
        <Field label="电话">
          <Input
            value={profile.phone}
            onChange={(e) => updateProfile({ phone: e.target.value })}
          />
        </Field>
        <Field label="邮箱">
          <Input
            value={profile.email}
            onChange={(e) => updateProfile({ email: e.target.value })}
          />
        </Field>
        <Field label="城市">
          <Input
            value={profile.location}
            onChange={(e) => updateProfile({ location: e.target.value })}
          />
        </Field>
        <Field label="个人网站">
          <Input
            value={profile.website}
            onChange={(e) => updateProfile({ website: e.target.value })}
          />
        </Field>
        <Field label="证件照（留空则不显示）">
          <div className="flex items-center gap-2">
            {profile.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.avatar}
                alt="证件照预览"
                className="size-10 shrink-0 rounded-md border border-border object-cover"
              />
            ) : null}
            <Input
              value={profile.avatar}
              onChange={(e) => updateProfile({ avatar: e.target.value })}
              placeholder="https://… 或点上传"
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                e.target.value = ""
                if (!f) return
                if (f.size > 1024 * 1024) {
                  setAvatarError("图片超过 1MB，请压缩后再上传")
                  return
                }
                setAvatarError(null)
                const reader = new FileReader()
                reader.onload = () => updateProfile({ avatar: String(reader.result) })
                reader.readAsDataURL(f)
              }}
            />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              上传
            </Button>
            {profile.avatar && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => updateProfile({ avatar: "" })}
              >
                清除
              </Button>
            )}
          </div>
          {avatarError && (
            <p role="alert" className="mt-1 text-xs text-destructive">
              {avatarError}
            </p>
          )}
        </Field>
        <Field label="链接（每行一条：名称|地址）">
          {/* key 挂链接指纹：store 外部变化（导入/重置）时重挂载同步显示；
            编辑期用 defaultValue+onBlur，避免半输入行被解析过滤造成打字抖动 */}
          <Textarea
            key={profile.links.map((l) => `${l.label}|${l.url}`).join("\n")}
            rows={2}
            defaultValue={profile.links
              .map((l) => `${l.label}|${l.url}`)
              .join("\n")}
            onBlur={(e) => {
              const links = e.target.value
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line, i) => {
                  const [label = "", url = ""] = line.split("|")
                  return { id: profile.links[i]?.id ?? `link-${i}`, label, url }
                })
                .filter((l) => l.label && l.url)
              updateProfile({ links })
            }}
            placeholder={"GitHub|https://github.com/you"}
          />
        </Field>
      </div>
    </PanelSection>
  )
}

function SummaryEditor() {
  const summary = useResumeStore((s) => s.resume.summary)
  const updateSummary = useResumeStore((s) => s.updateSummary)
  return (
    <PanelSection title="个人总结">
      <Textarea
        rows={4}
        value={summary}
        onChange={(e) => updateSummary(e.target.value)}
        placeholder="一段话介绍你自己，支持 **加粗** Markdown 语法"
      />
    </PanelSection>
  )
}

function EntriesEditor({
  collection,
  title,
  hints,
}: {
  collection: EntryCollection
  title: string
  hints: { title: string; subtitle: string }
}) {
  const entries = useResumeStore((s) => s.resume[collection])
  const addEntry = useResumeStore((s) => s.addEntry)
  const updateEntry = useResumeStore((s) => s.updateEntry)
  const removeEntry = useResumeStore((s) => s.removeEntry)
  const reorderEntry = useResumeStore((s) => s.reorderEntry)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  return (
    <PanelSection
      title={title}
      action={
        <Button size="sm" variant="outline" onClick={() => addEntry(collection)}>
          <Plus className="h-3.5 w-3.5" /> 添加
        </Button>
      }
    >
      <div className="space-y-4">
        {entries.map((entry: Entry, idx: number) => (
          <div
            key={entry.id}
            draggable
            onDragStart={(e) => {
              setDragId(entry.id)
              e.dataTransfer.effectAllowed = "move"
              e.dataTransfer.setData("text/plain", entry.id)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              if (dragId && entry.id !== dragId) setOverId(entry.id)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragId && dragId !== entry.id) reorderEntry(collection, dragId, entry.id)
              setDragId(null)
              setOverId(null)
            }}
            onDragEnd={() => {
              setDragId(null)
              setOverId(null)
            }}
            className={cn(
              "space-y-2.5 rounded-lg border bg-card p-3",
              dragId === entry.id && "opacity-40",
              overId === entry.id && dragId !== entry.id && "ring-2 ring-primary/40",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <GripVertical className="size-3.5 cursor-grab text-muted-foreground/60" />
                #{idx + 1}
              </span>
              <div className="flex gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive"
                      aria-label="删除"
                      onClick={() => removeEntry(collection, entry.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>删除</TooltipContent>
                </Tooltip>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={entry.title}
                onChange={(e) =>
                  updateEntry(collection, entry.id, { title: e.target.value })
                }
                placeholder={hints.title}
              />
              <Input
                value={entry.subtitle}
                onChange={(e) =>
                  updateEntry(collection, entry.id, { subtitle: e.target.value })
                }
                placeholder={hints.subtitle}
              />
              <Input
                value={entry.startDate}
                onChange={(e) =>
                  updateEntry(collection, entry.id, { startDate: e.target.value })
                }
                placeholder="开始时间 2021.04"
              />
              <Input
                value={entry.endDate}
                onChange={(e) =>
                  updateEntry(collection, entry.id, { endDate: e.target.value })
                }
                placeholder="结束时间 / 至今"
              />
            </div>
            <Input
              value={entry.location}
              onChange={(e) =>
                updateEntry(collection, entry.id, { location: e.target.value })
              }
              placeholder="城市（可选）"
            />
            <Input
              value={entry.badge ?? ""}
              onChange={(e) =>
                updateEntry(collection, entry.id, { badge: e.target.value || undefined })
              }
              placeholder="徽章（可选，如 驻场 / 全职）"
            />
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">内容</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-xs">
                    <WandSparkles className="size-3.5" /> 三段式脚手架
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {scaffoldLabels.map(({ kind, label }) => (
                    <DropdownMenuItem
                      key={kind}
                      onClick={() =>
                        updateEntry(collection, entry.id, {
                          body: scaffoldBody(kind, entry.body),
                        })
                      }
                    >
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <BulletLibraryButton
                section={collection === "projects" ? "project" : "work"}
                onInsert={(text) =>
                  updateEntry(collection, entry.id, {
                    body: `${entry.body.trimEnd()}${entry.body.trim() ? "\n" : ""}  - ${text}\n`,
                  })
                }
              />
              <AiPolishButton
                entry={entry}
                onApply={(md) => updateEntry(collection, entry.id, { body: md })}
              />
            </div>
            <Textarea
              rows={4}
              value={entry.body}
              onChange={(e) =>
                updateEntry(collection, entry.id, { body: e.target.value })
              }
              placeholder={"每行一个要点，以 - 开头\n- 负责……\n- 优化了 **核心指标**\n\n没有头绪？点上方「三段式脚手架」"}
            />
            <BodyHints text={entry.body} />
          </div>
        ))}
        {entries.length === 0 && (
          <p className="text-xs text-muted-foreground">
            暂无内容，点击右上角「添加」。
          </p>
        )}
      </div>
    </PanelSection>
  )
}

function SkillsEditor() {
  const skills = useResumeStore((s) => s.resume.skills)
  const addSkillGroup = useResumeStore((s) => s.addSkillGroup)
  const updateSkillGroup = useResumeStore((s) => s.updateSkillGroup)
  const removeSkillGroup = useResumeStore((s) => s.removeSkillGroup)
  return (
    <PanelSection
      title="技能特长"
      action={
        <Button size="sm" variant="outline" onClick={addSkillGroup}>
          <Plus className="h-3.5 w-3.5" /> 添加
        </Button>
      }
    >
      <div className="space-y-3">
        {skills.map((g) => (
          <div key={g.id} className="flex items-start gap-2">
            <Input
              className="w-28 shrink-0"
              value={g.name}
              onChange={(e) => updateSkillGroup(g.id, { name: e.target.value })}
              placeholder="分组名"
            />
            <Input
              value={g.keywords.join("、")}
              onChange={(e) =>
                updateSkillGroup(g.id, {
                  keywords: e.target.value.split(/[、,，]/).map((k) => k.trim()).filter(Boolean),
                })
              }
              placeholder="技能以 、 分隔"
            />
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 shrink-0 text-destructive"
              aria-label="删除技能分组"
              onClick={() => removeSkillGroup(g.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
    </PanelSection>
  )
}

function CustomEditor() {
  const custom = useResumeStore((s) => s.resume.custom)
  const addCustomSection = useResumeStore((s) => s.addCustomSection)
  const updateCustomSection = useResumeStore((s) => s.updateCustomSection)
  const removeCustomSection = useResumeStore((s) => s.removeCustomSection)
  return (
    <PanelSection
      title="自定义模块"
      action={
        <Button size="sm" variant="outline" onClick={addCustomSection}>
          <Plus className="h-3.5 w-3.5" /> 添加
        </Button>
      }
    >
      <div className="space-y-3">
        {custom.map((c) => (
          <div key={c.id} className="space-y-2 rounded-lg border bg-card p-3">
            <div className="flex items-center gap-2">
              <Input
                value={c.name}
                onChange={(e) =>
                  updateCustomSection(c.id, { name: e.target.value })
                }
                placeholder="模块名称，如：荣誉证书"
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-9 w-9 shrink-0 text-destructive"
                aria-label="删除自定义模块"
                onClick={() => removeCustomSection(c.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <Textarea
              rows={3}
              value={c.body}
              onChange={(e) =>
                updateCustomSection(c.id, { body: e.target.value })
              }
              placeholder="支持 Markdown 列表与 **加粗**"
            />
          </div>
        ))}
        {custom.length === 0 && (
          <p className="text-xs text-muted-foreground">
            可添加荣誉证书、自我评价等任意模块。
          </p>
        )}
      </div>
    </PanelSection>
  )
}

function LayoutEditor() {
  const sectionOrder = useResumeStore((s) => s.resume.sectionOrder)
  const hiddenSections = useResumeStore((s) => s.resume.hiddenSections)
  const toggleSection = useResumeStore((s) => s.toggleSection)
  const reorderSection = useResumeStore((s) => s.reorderSection)
  const [dragKey, setDragKey] = useState<SectionKey | null>(null)
  const [overKey, setOverKey] = useState<SectionKey | null>(null)
  return (
    <PanelSection title="模块布局">
      <div className="space-y-1.5">
        {sectionOrder.map((key) => {
          const hidden = hiddenSections.includes(key)
          return (
            <div
              key={key}
              draggable
              onDragStart={(e) => {
                setDragKey(key)
                e.dataTransfer.effectAllowed = "move"
                e.dataTransfer.setData("text/plain", key)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                if (dragKey && key !== dragKey) setOverKey(key)
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (dragKey && dragKey !== key) reorderSection(dragKey, key)
                setDragKey(null)
                setOverKey(null)
              }}
              onDragEnd={() => {
                setDragKey(null)
                setOverKey(null)
              }}
              className={cn(
                "flex items-center gap-2 rounded-md border bg-card px-3 py-2",
                dragKey === key && "opacity-40",
                overKey === key && dragKey !== key && "ring-2 ring-primary/40",
              )}
            >
              <GripVertical className="size-3.5 cursor-grab text-muted-foreground/60" />
              <span
                className={
                  hidden ? "flex-1 text-sm text-muted-foreground line-through" : "flex-1 text-sm"
                }
              >
                {SECTION_NAMES[key]}
              </span>
              <Switch
                checked={!hidden}
                onCheckedChange={() => toggleSection(key)}
                aria-label={`显示${SECTION_NAMES[key]}`}
              />
              {hidden ? (
                <EyeOff className="size-3.5 text-muted-foreground" />
              ) : (
                <Eye className="size-3.5 text-muted-foreground" />
              )}
            </div>
          )
        })}
      </div>
    </PanelSection>
  )
}

export function EditorPanel() {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 p-4">
        <ProfileEditor />
        <SummaryEditor />
        <EntriesEditor
          collection="work"
          title="工作经历"
          hints={{ title: "公司名称", subtitle: "职位" }}
        />
        <EntriesEditor
          collection="projects"
          title="项目经历"
          hints={{ title: "项目名称", subtitle: "角色 / 亮点" }}
        />
        <EntriesEditor
          collection="education"
          title="教育经历"
          hints={{ title: "学校名称", subtitle: "专业 · 学历" }}
        />
        <SkillsEditor />
        <CustomEditor />
        <LayoutEditor />
      </div>
    </ScrollArea>
  )
}
