/**
 * 条目内容检测规则引擎（R3）：量化缺失 + 弱动词开头。
 * 纯字符串规则，只提示不强制（G4-35）；O(n) 可逐渲染调用。
 */

export interface ContentHint {
  /** 命中的行（0-based，相对传入文本） */
  line: number
  /** 该行文本 */
  excerpt: string
  message: string
}

const QUANT_RE = /\d|%|％|倍|万|亿|k\b|K\b|Q[1-4]|[0-9]+(\.[0-9]+)?(s|ms|分钟|小时|天|周|月|年)/
/** 弱动词 → 改写公式提示 */
const WEAK_VERBS: Array<[RegExp, string]> = [
  [/^(负责|负责了)/, "「负责」看不出贡献——改为：主导 / 独立完成 / 牵头"],
  [/^(参与|参与了)/, "「参与」弱化个人价值——改为：主导某模块 / 推动某环节，并给出你的具体产出"],
  [/^(做了|做了些)/, "「做了」太含糊——改为：动词 + 对象 + 结果"],
  [/^(协助|协助了)/, "「协助」难以体现深度——改为：承担〔具体环节〕，产出〔具体结果〕"],
  [/^(进行|进行了)/, "「进行了 X」是名词化表达——改为直接动词：优化 X / 重构 X"],
  [/^(完成|完成了)/, "「完成」是及格线——补上结果与量化更佳"],
  [/^(帮忙|帮助)/, "「帮助」弱化主导性——改为：主导 / 推动 / 落地"],
]

const isBullet = (line: string) => /^\s*-\s+/.test(line)

/** 量化缺失检测：bullet 无任何数字/百分比/量纲 → 建议补量化 */
export function quantifyHints(text: string): ContentHint[] {
  const hints: ContentHint[] = []
  text.split("\n").forEach((line, i) => {
    const t = line.trim()
    if (!isBullet(line) || t.replace(/^-\s*/, "").length < 8) return
    if (!QUANT_RE.test(t)) {
      hints.push({
        line: i,
        excerpt: t.replace(/^-\s*/, "").slice(0, 40),
        message: "缺量化——补上数字：百分比 / 倍数 / 耗时 / 规模（数字是简历的硬通货）",
      })
    }
  })
  return hints
}

/** 弱动词检测：bullet 以含糊动词开头 → 给改写公式 */
export function weakVerbHints(text: string): ContentHint[] {
  const hints: ContentHint[] = []
  text.split("\n").forEach((line, i) => {
    const t = line.trim()
    if (!isBullet(line)) return
    const content = t.replace(/^-\s*/, "")
    for (const [re, advice] of WEAK_VERBS) {
      if (re.test(content)) {
        hints.push({ line: i, excerpt: content.slice(0, 40), message: advice })
        break
      }
    }
  })
  return hints
}

export interface EntryReview {
  quantify: ContentHint[]
  weakVerb: ContentHint[]
}

export function reviewEntryBody(body: string): EntryReview {
  return { quantify: quantifyHints(body), weakVerb: weakVerbHints(body) }
}
