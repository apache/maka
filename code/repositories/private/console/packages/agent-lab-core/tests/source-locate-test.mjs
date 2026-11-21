// scripts/source-locate-test.mjs —— js/source-locate.js 的无头测试（纯函数，不碰 DOM）。
// 覆盖：函数/生成器/箭头/const 对象属性/class 方法的定位、模板串 ${} 与注释里的花括号、
// 路径键与裸键、未知名兜底。
// 运行：node scripts/source-locate-test.mjs（npm test 会自动带上）

import { parseDeclarations, locate } from '../src/web-utils/source-locate.js'

let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log('PASS ' + name)
  } else {
    failed++
    console.log('FAIL ' + name + (extra ? ' — ' + extra : ''))
  }
}

// 行号约定：startLine/endLine 均为 0 起、含两端。
const snippet = [
  "// 文件头注释",                                        // 0
  "export async function* stream(model, ctx) {",           // 1
  "  const out = `file not found: ${p}（现有文件：${q}）`", // 2  模板串嵌 ${}
  "  while (true) {",                                      // 3
  "    yield { type: 'text_delta' }",                      // 4
  "  }",                                                   // 5
  "}",                                                     // 6
  "",                                                      // 7
  "const edit = {",                                        // 8
  "  name: 'edit',",                                       // 9
  "  execute: async (args) => {",                          // 10
  "    const s = 'str with } unbalanced brace'",           // 11  字符串里的 }
  "    return s",                                          // 12
  "  },",                                                  // 13
  "}",                                                     // 14
  "",                                                      // 15
  "export class Tui {",                                    // 16
  "  constructor(root) {",                                 // 17
  "    this.root = root",                                  // 18
  "  }",                                                   // 19
  "",                                                      // 20
  "  printText(delta, src) {",                             // 21
  "    // 行注释里有个不配平的 {",                            // 22
  "    /* 块注释里也有 } */",                                // 23
  "    return delta",                                      // 24
  "  }",                                                   // 25
  "}",                                                     // 26
].join('\n')

// ===== 1. 顶层函数（含 export async function* 生成器） =====
{
  const d = locate(snippet, 'stream')
  check('生成器函数定位到起始行', d && d.startLine === 1, JSON.stringify(d))
  check('模板串 ${} 不影响配平，结束行正确', d && d.endLine === 6, JSON.stringify(d))
}

// ===== 2. const 对象 + 属性路径 =====
{
  const d = locate(snippet, 'edit.execute')
  check('属性路径 edit.execute 起始行', d && d.startLine === 10, JSON.stringify(d))
  check('字符串里的 } 不影响配平，结束行正确', d && d.endLine === 13, JSON.stringify(d))
  const bare = locate(snippet, 'execute')
  check('裸键 execute 同样命中', bare && bare.startLine === 10)
  const whole = locate(snippet, 'edit')
  check('整个 const edit 块可定位', whole && whole.startLine === 8 && whole.endLine === 14, JSON.stringify(whole))
}

// ===== 3. class 与方法 =====
{
  const cls = locate(snippet, 'Tui')
  check('整个 class 块可定位', cls && cls.startLine === 16 && cls.endLine === 26, JSON.stringify(cls))
  const ctor = locate(snippet, 'Tui.constructor')
  check('方法路径 Tui.constructor', ctor && ctor.startLine === 17 && ctor.endLine === 19, JSON.stringify(ctor))
  const m = locate(snippet, 'Tui.printText')
  check('注释里的花括号被跳过，printText 结束行正确', m && m.startLine === 21 && m.endLine === 25, JSON.stringify(m))
  check('裸键 printText 命中方法', locate(snippet, 'printText').startLine === 21)
}

// ===== 4. 兜底与未知名 =====
{
  check('未知路径退回最后一段', locate(snippet, 'xx.execute').startLine === 10)
  check('完全未知名返回 null', locate(snippet, 'nope') === null)
  check('空名返回 null', locate(snippet, '') === null)
}

// ===== 5. parseDeclarations 键集合抽查 =====
{
  const decls = parseDeclarations(snippet)
  const keys = [...decls.keys()]
  check('声明表含顶层与成员双键', ['stream', 'edit', 'edit.execute', 'Tui', 'Tui.printText', 'printText'].every((k) => keys.includes(k)), keys.join(','))
  check('字符串属性 name: 不入表', !keys.some((k) => k === 'edit.name' || k === 'name'))
}

// ===== 6. 回归：参数默认值里的 {} 不提前"配平"函数体 =====
{
  const snippet2 = [
    "export async function* stream(model, context, opts = {}) {", // 0
    "  const url = `${model.baseUrl ?? 'https://x/v1'}/chat/completions`", // 1
    "  yield { type: 'done' }",                                    // 2
    "}",                                                           // 3
    "",                                                            // 4
    "export function noDefaults(a, b) {",                          // 5
    "  return a",                                                  // 6
    "}",                                                           // 7
  ].join('\n')
  const d = locate(snippet2, 'stream')
  check('参数默认值 {} 不截断函数体', d && d.startLine === 0 && d.endLine === 3, JSON.stringify(d))
  const d2 = locate(snippet2, 'noDefaults')
  check('无默认值函数不受影响', d2 && d2.startLine === 5 && d2.endLine === 7, JSON.stringify(d2))
}

// ===== 7. 回归：括号内的模板串插值 ${} 不卡死模板栈 =====
{
  const snippet3 = [
    "export async function post(url, opts = {}) {",                              // 0
    "  const r = await fetch(url, {",                                            // 1
    "    headers: { authorization: `Bearer ${opts.key}` },",                     // 2
    "    body: JSON.stringify(opts.body),",                                      // 3
    "  })",                                                                      // 4
    "  return r",                                                                // 5
    "}",                                                                         // 6
    "",                                                                          // 7
    "export function next() {",                                                  // 8
    "  return 1",                                                                // 9
    "}",                                                                         // 10
  ].join('\n')
  const d = locate(snippet3, 'post')
  check('括号内插值 ${} 后块仍正确闭合', d && d.startLine === 0 && d.endLine === 6, JSON.stringify(d))
  const d2 = locate(snippet3, 'next')
  check('后续函数不受牵连', d2 && d2.startLine === 8 && d2.endLine === 10, JSON.stringify(d2))
}

// 汇总
if (failed === 0) {
  console.log('ALL SOURCE-LOCATE TESTS PASSED')
} else {
  console.log(failed + ' SOURCE-LOCATE TEST(S) FAILED')
  process.exit(1)
}
