/**
 * 条目内容脚手架（R1）：把「职责流水账」引导成「挑战 → 方案 → 结果」叙事。
 * 生成纯 Markdown 文本追加进 entry.body，不改数据模型。
 * 风格参照木及三段式：■ 前缀一级要点 + 两空格缩进二级要点。
 */

export type ScaffoldKind = "work" | "project" | "generic"

interface ScaffoldSpec {
  label: string
  sections: Array<{ title: string; hint: string }>
}

const SPECS: Record<ScaffoldKind, ScaffoldSpec> = {
  work: {
    label: "三段式（工作经历）",
    sections: [
      { title: "核心挑战", hint: "业务复杂度 / 技术难点 / 约束条件" },
      { title: "关键设计与实践", hint: "方案选型 / 落地动作，动词开头" },
      { title: "结果与影响", hint: "量化收益：性能 / 效率 / 成本 / 稳定性" },
    ],
  },
  project: {
    label: "三段式（项目）",
    sections: [
      { title: "背景与目标", hint: "项目解决什么问题，为谁解决" },
      { title: "技术方案", hint: "架构 / 关键技术决策及理由" },
      { title: "成效", hint: "量化结果：指标提升 / 用户价值" },
    ],
  },
  generic: {
    label: "三段式（通用）",
    sections: [
      { title: "核心挑战", hint: "难在哪" },
      { title: "关键设计与实践", hint: "怎么解决" },
      { title: "结果与影响", hint: "带来了什么" },
    ],
  },
}

/**
 * 生成三段式骨架文本。已有内容时先空一行再追加（不覆盖）。
 * 每段：■ **标题**：提示行 + 两空格缩进的空白要点（- 前缀）。
 */
export function scaffoldBody(kind: ScaffoldKind, existingBody: string): string {
  const spec = SPECS[kind]
  const skeleton = spec.sections
    .map(
      (s) =>
        `- ■ **${s.title}**：${s.hint}\n  - \n  - `,
    )
    .join("\n")
  const base = existingBody.trimEnd()
  return base ? `${base}\n\n${skeleton}\n` : `${skeleton}\n`
}

/** 一句话价值概述开头行（可选插入 body 首行） */
export function summaryLeadLine(role = "本项目"): string {
  return `**一句话概述**：面向〔目标用户〕的${role}，解决了〔核心问题〕。\n`
}

export const scaffoldLabels = Object.entries(SPECS).map(([kind, s]) => ({
  kind: kind as ScaffoldKind,
  label: s.label,
}))
