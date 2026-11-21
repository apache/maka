#!/usr/bin/env node
/**
 * 样式检查：扫描 tsx/ts 里的 Tailwind 原生调色板类（raw palette）。
 *
 * 规范见 docs/design/DESIGN.md：颜色必须走语义 token（bg-primary / text-muted-foreground /
 * text-destructive / text-success …），禁止 bg-emerald-700、text-stone-400 这类裸色名——
 * 裸色名绕过明暗双板，是四套 UI 体系并存的根源。
 *
 * - lab 豁免区（EXEMPT_PREFIXES）：/lab 作用域主题自洽，见 DESIGN.md「模块豁免」。
 * - 欠债白名单（ALLOWLIST）：历史文件逐个豁免，还清一个删一个（只减不增）。
 *
 * 运行：pnpm style:check；有白名单外的违规则退出码 1。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SCAN_DIRS = ['apps', 'packages'].map((d) => join(ROOT, d))
const EXTENSIONS = new Set(['.tsx', '.ts', '.jsx', '.js'])

/** 豁免区：lab 作用域主题 + verbatim 移植模块源码（AGENTS.md 豁免边界，改风格即破坏保真） */
const EXEMPT_PREFIXES = [
  join(ROOT, 'apps/agent/src/app/lab'),
  join(ROOT, 'apps/toolbox/src/features/chat-viewer'),
  join(ROOT, "apps/agent/src/features/interview-gym"),
  join(ROOT, "apps/agent/src/features/diffmap"),
]

/** 欠债白名单：历史上已存在的裸色名文件。重构收编后从此处删除（只减不增）。 */
const ALLOWLIST = []

// shadcn 定制层（packages/ui）持有原语实现，overlay/badge 变体等处允许用原生色；
// 原语内的裸色收编列为路线图欠债，不在本检查的强制范围。
const LAYER_EXEMPT = join(ROOT, 'packages/ui/src')

const PALETTE =
  /(?:bg|text|border|ring|fill|stroke|divide|outline|decoration|accent|caret|placeholder|from|via|to|shadow|inset)-(?:black|white|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{1,3})?(?:\/\d{1,3})?\b/g

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '.next') continue
      yield* walk(p)
    } else if (EXTENSIONS.has(name.slice(name.lastIndexOf('.')))) {
      yield p
    }
  }
}

const violations = []
for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) {
    if (EXEMPT_PREFIXES.some((pre) => file.startsWith(pre + sep))) continue
    if (file.startsWith(LAYER_EXEMPT + sep)) continue
    const rel = file.slice(ROOT.length + 1).replaceAll(sep, '/')
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      // 行内豁免：物理媒介/动态数据色（A4 纸白、简历主题底上的白字等）无法用语义 token
      // 表达，在该行尾以 // style:ok <理由> 固化判断；其余位置仍照常拦截
      if (line.includes('// style:ok')) return
      for (const m of line.matchAll(PALETTE)) {
        // 遮罩 scrim 豁免：bg-black/NN 是模态遮罩的行业惯例（压暗与明暗主题无关，ui/dialog、ui/drawer 同款）；
        // 其余位置（text-black、无透明度的 bg-black 等）仍照常拦截
        if (/^bg-black\/\d{1,3}$/.test(m[0])) continue
        violations.push({ rel, line: i + 1, match: m[0] })
      }
    })
  }
}

const debt = violations.filter((v) => ALLOWLIST.includes(v.rel))
const fresh = violations.filter((v) => !ALLOWLIST.includes(v.rel))

for (const v of fresh) console.log(`${v.rel}:${v.line}  ${v.match}`)
const byFile = {}
for (const v of debt) byFile[v.rel] = (byFile[v.rel] ?? 0) + 1
for (const [rel, n] of Object.entries(byFile)) console.log(`[白名单欠债] ${rel}  ${n} 处`)

console.log(
  `\n裸色名：白名单外 ${fresh.length} 处，白名单内 ${debt.length} 处（欠债文件 ${Object.keys(byFile).length}/${ALLOWLIST.length}）`,
)
if (fresh.length > 0) {
  console.log('→ 新代码禁止裸色名，改用语义 token（见 docs/design/DESIGN.md）；确需豁免先加白名单并说明。')
  process.exit(1)
}
