// js/source-locate.js —— 在源码文本里定位一个函数的行区间（纯函数，无 DOM）。
//
// 源码联动视图（期5）的地基：终端里点 [agent.js · runAgent] 标签，
// 就要能跳到 agent.js 源码的 runAgent 那几行。没有编译器 API、不引解析器，
// 自己写一个够用的小扫描器——这本身就是一堂"源码即文本"的课。
//
// 两步走：
//   parseDeclarations(text)  扫出全部声明：函数 / const 箭头 / const 对象 / class 及其成员
//   locate(text, fnPath)     按 'runAgent' / 'edit.execute' / 'MapView.pulse' 取行区间
//
// 已知边界（诚实声明）：花括号计数靠迷你词法扫描跳过字符串与注释，
// 但不识别正则字面量（本项目源码里没有）；无块箭头函数（x => x）会定位失准
// （本项目源码全部使用块体）。规则由我们自己守。

/**
 * 扫描声明。返回 Map：名字 → { startLine, endLine }（0 起行号，含两端）。
 * 成员同时注册两把钥匙：'parent.member' 与裸 'member'（后者可能被覆盖，先命中先用）。
 */
export function parseDeclarations(text) {
  const lines = text.split('\n')
  const decls = new Map()

  // 顶层声明（行首无缩进）：function / function* / const … = / class
  const topRe = [
    // export async function* name( / function name(
    { re: /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'fn' },
    // export const name = …（箭头或对象字面量，是否有块体由 findBlockEnd 判断）
    { re: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'const' },
    // export class Name
    { re: /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  ]

  const topLevel = []
  for (let i = 0; i < lines.length; i++) {
    for (const { re, kind } of topRe) {
      const m = lines[i].match(re)
      if (!m) continue
      const end = findBlockEnd(lines, i)
      topLevel.push({ name: m[1], kind, start: i, end })
      decls.set(m[1], { startLine: i, endLine: end })
      break // 一行只算一个声明
    }
  }

  // 成员声明（恰好 2 空格缩进，即顶层块的第一层）：
  //   class 方法：  pulse(edgeKey, reverse, color) {
  //   对象属性：    execute: async (args) => {   /   parameters: {
  const methodRe = /^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/
  const propRe = /^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?[{(]/

  for (const top of topLevel) {
    for (let i = top.start + 1; i <= top.end; i++) {
      const line = lines[i]
      const m = line.match(methodRe) ?? line.match(propRe)
      if (!m) continue
      const end = findBlockEnd(lines, i)
      decls.set(`${top.name}.${m[1]}`, { startLine: i, endLine: end })
      if (!decls.has(m[1])) decls.set(m[1], { startLine: i, endLine: end })
    }
  }

  return decls
}

/**
 * 定位 fnPath → { startLine, endLine }（0 起）；找不到返回 null。
 * 'edit.execute' 找不到时退回最后一段 'execute'——src 标签里的名字以它为准。
 */
export function locate(text, fnPath) {
  if (!fnPath) return null
  const decls = parseDeclarations(text)
  if (decls.has(fnPath)) return decls.get(fnPath)
  const last = fnPath.split('.').pop()
  return decls.get(last) ?? null
}

/**
 * 从 fromLine（0 起）向下找第一个配平的花括号块，返回结束行号。
 * 迷你词法扫描：逐字符走，跳过 '…' / "…" / `…` / 行注释 / 块注释；
 * 模板串里的 ${…} 视为代码段（压栈处理，支持嵌套模板），其花括号单独配对、
 * 不污染外层计数——不然 `file not found: ${p}（…）` 就会把块提前"配平"。
 *
 * 参数列表守卫：括号内的花括号不计入。不然 `function f(opts = {}) {` 里
 * 默认值的 {} 先配平到零，函数体就被"结束"在声明行上了。
 */
function findBlockEnd(lines, fromLine) {
  let braceDepth = 0
  let parenDepth = 0
  let started = false
  let state = 'code' // code | line | block | squote | dquote | template
  const tmplStack = [] // 进入 ${ 时暂存外层状态（模板可嵌套）

  for (let i = fromLine; i < lines.length; i++) {
    const s = lines[i]
    for (let k = 0; k < s.length; k++) {
      const c = s[k]
      const next = s[k + 1]

      if (state === 'line') break // 行注释到行尾，直接下一行
      if (state === 'block') {
        if (c === '*' && next === '/') { state = 'code'; k++ }
        continue
      }
      if (state === 'squote' || state === 'dquote') {
        if (c === '\\') k++ // 跳过转义字符
        else if ((state === 'squote' && c === "'") || (state === 'dquote' && c === '"')) state = 'code'
        continue
      }
      if (state === 'template') {
        if (c === '\\') { k++; continue }
        if (c === '`') { state = 'code'; continue }
        if (c === '$' && next === '{') { tmplStack.push('template'); state = 'code'; k++; continue }
        continue
      }

      // state === 'code'
      if (c === '/' && next === '/') { state = 'line'; break }
      if (c === '/' && next === '*') { state = 'block'; k++; continue }
      if (c === "'") { state = 'squote'; continue }
      if (c === '"') { state = 'dquote'; continue }
      if (c === '`') { state = 'template'; continue }
      // ${…} 的闭合必须先于参数守卫：fetch(url, { authorization: `Bearer ${k}` })
      // 里插值的 } 处在括号内，被守卫吞掉的话模板栈就永远弹不出来了
      if (c === '}' && tmplStack.length) { tmplStack.pop(); state = 'template'; continue }
      if (c === '(') { parenDepth++; continue }
      if (c === ')') { parenDepth = Math.max(0, parenDepth - 1); continue }
      if (parenDepth > 0) continue // 参数列表里的花括号一概不计
      if (c === '{') { braceDepth++; started = true; continue }
      if (c === '}') {
        braceDepth--
        if (started && braceDepth === 0) return i
        if (braceDepth < 0) return i // 源码本身不平衡，就地止损
      }
    }
    if (state === 'line') state = 'code' // 换行退出行注释
  }
  return lines.length - 1 // 直到文件尾都没配平：返回末行
}
