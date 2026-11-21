// scripts/tour-test.mjs —— 走读关卡数据校验（期8 建，期10 扩展 tools 篇与 compaction 关）。
// 关卡的行号直接钉在源码上：源文件改动导致行号漂移、区间越界、
// 断点类型拼错、文案缺失，这里立刻红——教学文案不能指向不存在的行。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { TOUR_SECTIONS, DEMO_TASK } from '../src/tour-data.js'
import { BREAKPOINT_TYPES } from '../src/web-utils/pump.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const ok = (name) => { console.log(`PASS ${name}`) }
const bad = (name, why) => { failed++; console.error(`FAIL ${name} — ${why}`) }

// 1. 结构：三篇（agent / llm / tools），每篇有标题、副标题、非空关卡列表
const SECTION_IDS = ['agent', 'llm', 'tools']
if (TOUR_SECTIONS.length === SECTION_IDS.length
  && TOUR_SECTIONS.every((s, i) => s.id === SECTION_IDS[i]))
  ok(`共三篇（${SECTION_IDS.join(' / ')}）`)
else bad('篇结构', `期望 [${SECTION_IDS}]，得到 [${TOUR_SECTIONS.map(s => s.id)}]`)
const ids = new Set()
for (const sec of TOUR_SECTIONS) {
  if (sec.id && sec.title && sec.subtitle && sec.file && sec.steps.length >= 5)
    ok(`篇结构 ${sec.id}（${sec.steps.length} 关）`)
  else bad(`篇结构 ${sec.id}`, '缺 id/title/subtitle/file 或关卡少于 5')
}

// 2. 逐关校验
for (const sec of TOUR_SECTIONS) {
  const src = readFileSync(resolve(root, 'src', sec.file), 'utf8')
  const total = src.split('\n').length
  for (const step of sec.steps) {
    const name = `${sec.id}:${step.id} ${step.title}`
    if (ids.has(step.id)) bad(name, 'id 重复'); ids.add(step.id)
    if (!step.title) bad(name, '缺标题')
    if (!Array.isArray(step.teach) || step.teach.length === 0 || step.teach.some(t => !t.trim()))
      bad(name, '讲解文案缺失或为空')
    // 行区间：1-based 闭区间，落在文件行数内，start <= end
    const [a, b] = step.lines
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || a > b || b > total)
      bad(name, `行区间 [${a}, ${b}] 非法（文件共 ${total} 行）`)
    else if (!step.anchor)
      bad(name, '缺 anchor（区间内容锚点——防行号漂移到错误段落）')
    else if (!src.split('\n').slice(a - 1, b).join('\n').includes(step.anchor))
      bad(name, `anchor "${step.anchor}" 不在 ${a}-${b} 行内——源码可能已改动，关卡行号漂移`)
    else ok(`${name} · ${a}-${b} 行 · anchor 命中`)
    // runTo：bp 必须是真实断点类型；task 可省（默认演示任务）
    if (step.runTo) {
      if (!BREAKPOINT_TYPES.includes(step.runTo.bp))
        bad(name, `runTo.bp "${step.runTo.bp}" 不在 BREAKPOINT_TYPES 里`)
      else ok(`${name} · runTo ${step.runTo.bp}`)
    }
    // runTo 与 watch 互斥：一张卡只给一种实跑指引
    if (step.runTo && step.watch) bad(name, 'runTo 与 watch 不应同时出现')
  }
}

// 3. runTo 覆盖：各篇至少覆盖声明的断点类型
const secBps = (id) => {
  const sec = TOUR_SECTIONS.find(s => s.id === id)
  return new Set(sec.steps.filter(s => s.runTo).map(s => s.runTo.bp))
}
for (const bp of ['tool_call', 'tool_result', 'turn_end', 'round_start', 'compact_end'])
  (secBps('agent').has(bp) ? ok : bad).call(null, `agent 篇覆盖 ${bp} 断点`)
for (const bp of ['tool_call', 'tool_result'])
  (secBps('tools').has(bp) ? ok : bad).call(null, `tools 篇覆盖 ${bp} 断点`)

// 4. tools 篇内容覆盖：四个工具都在讲解文案里出现（防漏讲）
const toolsTeach = TOUR_SECTIONS.find(s => s.id === 'tools')
  .steps.map(s => s.teach.join('')).join('\n')
for (const name of ['read_file', 'write_file', 'edit', 'run_js'])
  (toolsTeach.includes(name) ? ok : bad).call(null, `tools 篇讲到 ${name}`)

if (DEMO_TASK.includes('test.js')) ok('演示任务指向预置 bug 项目')
else bad('演示任务', 'DEMO_TASK 未指向预置项目')

console.log(failed === 0 ? '\nALL TOUR TESTS PASSED' : `\n${failed} TOUR TEST(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
