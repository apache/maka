// js/vfs.js
// 虚拟文件系统 —— 在浏览器内存里替代 node:fs，是 tools.js 的地基。
//
// 三件事：
//   1. 预置一个"带 bug 的 mini 项目"（math.js + test.js + README.md）
//   2. 内存文件的读 / 写 / 列表（路径规范化：支持 ./ ../ / 绝对式写法）
//   3. runJs()：用 new Function 真执行虚拟 FS 里的 JS，捕获 console 输出
//      （CommonJS 风格 require，带模块缓存防循环引用）
//
// 注意：new Function 不是安全沙盒——代码仍能访问全局对象，教学隔离足够。
// 真正的隔离要看 Realm / iframe / Worker，那是另一个课题，这里不展开。

/** 文件表：规范化路径 → 文件内容 */
const files = new Map()

/**
 * 版本史：path → [{ content, tool }]，第 0 项是基线（预置内容，或新文件的空串）。
 * 每次 write_file / edit 都追加一版并记下是哪个工具写的——
 * 相当于 agent 的"commit 历史"，期4 的 diff 视图就渲染它。
 */
const history = new Map()

/** 预置沙盒项目：一个行为怪异的数学工具库 + 会失败的测试 */
const PRESET_FILES = {
  'README.md': [
    '# 沙盒项目：math.js 工具库',
    '',
    '- math.js：三个数学函数（add / subtract / average）',
    '- test.js：测试脚本，全部通过会输出 ALL TESTS PASSED',
    '',
    '任务：找出并修复 math.js 里的 bug，让 test.js 全部通过。',
  ].join('\n'),

  'math.js': [
    '// 简易数学工具库（CommonJS 风格导出，供 require 使用）',
    'function add(a, b) {',
    '  return a + b',
    '}',
    '',
    '// 不知道为什么，5 - 3 的结果总是不对，没人改过这段代码……',
    'function subtract(a, b) {',
    '  return a + b',
    '}',
    '',
    'function average(nums) {',
    '  return nums.reduce(function (sum, n) { return sum + n }, 0) / nums.length',
    '}',
    '',
    'module.exports = { add: add, subtract: subtract, average: average }',
  ].join('\n'),

  'test.js': [
    '// 测试脚本：零依赖的极简断言。修复 math.js 后用它验证。',
    'var math = require("./math.js")',
    'var failed = 0',
    '',
    'function check(name, actual, expected) {',
    '  if (actual === expected) {',
    '    console.log("PASS " + name)',
    '  } else {',
    '    failed = failed + 1',
    '    console.log("FAIL " + name + ": expected " + expected + ", got " + actual)',
    '  }',
    '}',
    '',
    'check("add(2, 3)", math.add(2, 3), 5)',
    'check("subtract(5, 3)", math.subtract(5, 3), 2)',
    'check("average([2, 4, 6])", math.average([2, 4, 6]), 4)',
    '',
    'if (failed === 0) {',
    '  console.log("ALL TESTS PASSED")',
    '} else {',
    '  console.log(failed + " TEST(S) FAILED")',
    '}',
  ].join('\n'),
}

/** 重置沙盒：清空文件与版本史，恢复预置项目 */
export function resetSandbox() {
  files.clear()
  history.clear()
  for (const [path, content] of Object.entries(PRESET_FILES)) {
    files.set(path, content)
    history.set(path, [{ content, tool: 'preset' }])
  }
}

/**
 * 路径规范化：所有路径都相对虚拟根目录 '/'。
 * './a/../b.js' → 'b.js'；'/x.js' → 'x.js'（前导斜杠只是写法，没有真实磁盘根）
 * '..' 越过根目录就被忽略——比 node 的语义简单，够用。
 */
export function normalizePath(p) {
  const parts = String(p ?? '').replaceAll('\\', '/').split('/')
  const out = []
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return out.join('/')
}

/** 读文件；不存在时抛错（错误信息会原样返回给模型，它会自己纠正路径） */
export function readFile(path) {
  const p = normalizePath(path)
  if (!files.has(p)) throw new Error(`file not found: ${p}（现有文件：${listFiles().join(', ')}）`)
  return files.get(p)
}

/**
 * 覆盖写；自动创建"目录"——内存 Map 不需要 mkdir，路径即键。
 * tool 参数只用于版本史标注（'write_file' / 'edit'），不影响写入本身。
 */
export function writeFile(path, content, tool = 'write_file') {
  const p = normalizePath(path)
  if (!history.has(p)) {
    // 首次触碰的文件：以现有内容为基线建版本史（新文件基线是空串，diff 全绿）
    history.set(p, [{ content: files.has(p) ? files.get(p) : '', tool: 'init' }])
  }
  files.set(p, String(content))
  history.get(p).push({ content: files.get(p), tool })
  return p
}

/** 版本史（含基线）；从未写过的文件返回单条当前内容，不存在的返回空数组 */
export function getHistory(path) {
  const p = normalizePath(path)
  if (history.has(p)) return history.get(p)
  return files.has(p) ? [{ content: files.get(p), tool: 'preset' }] : []
}

/** 列出全部文件（排序稳定，方便测试和展示） */
export function listFiles() {
  return [...files.keys()].sort()
}

// ===== run_js 沙盒 =====

/** console 参数格式化：与真实 console 一致的宽松拼接 */
function fmt(v) {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || String(v)
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

function dirname(p) {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

/** 拼接相对路径：spec 以 / 开头视为根相对，否则相对 fromDir */
function joinPath(dir, spec) {
  if (spec.startsWith('/')) return spec
  return dir ? `${dir}/${spec}` : spec
}

/**
 * 执行虚拟 FS 里的一个 JS 文件，返回捕获的全部 console 输出。
 * 实现：new Function 把 console / require / module / exports 作为参数注入——
 * 沙盒代码里的 console.log 落进 lines 数组，require 递归回到本函数加载依赖。
 */
export function runJs(entryPath) {
  const lines = []
  const sandboxConsole = {}
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    sandboxConsole[method] = (...args) => lines.push(args.map(fmt).join(' '))
  }
  const moduleCache = new Map() // 规范化路径 → module（缓存，防循环 require）

  function makeRequire(fromDir) {
    return (spec) => {
      let p = normalizePath(joinPath(fromDir, spec))
      if (!p.endsWith('.js')) p += '.js' // 裸模块名自动补 .js，如 require('math')
      if (moduleCache.has(p)) return moduleCache.get(p).exports
      if (!files.has(p)) throw new Error(`cannot find module '${spec}' (resolved: ${p})`)
      const mod = { exports: {} }
      moduleCache.set(p, mod) // 先缓存再执行——require 循环时返回半成品，与 node 行为一致
      const fn = new Function('console', 'require', 'module', 'exports', files.get(p))
      fn(sandboxConsole, makeRequire(dirname(p)), mod, mod.exports)
      return mod.exports
    }
  }

  let entry = normalizePath(entryPath)
  if (!entry.endsWith('.js')) entry += '.js'
  if (!files.has(entry)) return `error: file not found: ${entry}（现有文件：${listFiles().join(', ')}）`

  try {
    makeRequire(dirname(entry))(entry)
    return lines.length ? lines.join('\n') : '(no output)'
  } catch (e) {
    const head = lines.length ? `${lines.join('\n')}\n` : ''
    return `${head}[runtime error] ${e && e.message ? e.message : e}`
  }
}

// 启动即预置好沙盒项目
resetSandbox()
