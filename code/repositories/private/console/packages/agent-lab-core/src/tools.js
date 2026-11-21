// js/tools.js
// 4 个内置工具 —— 全部操作 vfs.js 的虚拟文件系统，不碰真实磁盘。
// 每个 tool 是纯函数：async (args) => string，不碰 agent 状态。
// 注意：教学版不验证 args，生产 agent 应在 execute 前用 parameters validate 参数。
//
// 与 pi-from-scratch/src/tools.ts 对应，两处替换：
//   read/write/edit：node:fs → vfs.js（内存 Map）
//   run_bash → run_js：浏览器没有 shell，改在沙盒里真执行 JS 并捕获 console
//               ——"执行验证"这个 coding agent 的灵魂能力保留了

import * as vfs from './web-utils/vfs.js'

// ─── 1. truncateOutput：输出截断保护（尾部优先——错误信息通常在末尾） ────
/** 工具输出截取上限（行数），超过则截取尾部。尾部优先——错误信息通常在末尾 */
const MAX_OUTPUT_LINES = 200

/**
 * 截取工具输出。与 TS 版差异：不把完整输出写临时文件（浏览器没有），
 * 直接提示截断。沙盒项目文件都很小，正常路径走不到这里。
 */
function truncateOutput(content, maxLines = MAX_OUTPUT_LINES) {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  const kept = lines.slice(-maxLines).join('\n')
  return `[output truncated: showing last ${maxLines} of ${lines.length} lines]\n${kept}`
}

// ─── 2. read_file / write_file：读与写（最简单的两个） ────────────────
/** read_file：读取虚拟沙盒中的文件内容 */
const readFile = {
  name: 'read_file',
  description: '读取沙盒虚拟文件的内容。参数：path（文件路径，如 math.js）。大文件截取最后 200 行。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径' },
    },
    required: ['path'],
  },
  execute: async (args) => {
    return truncateOutput(vfs.readFile(args.path))
  },
}

/** write_file：覆盖写入虚拟文件 */
const writeFile = {
  name: 'write_file',
  description: '写入虚拟文件（覆盖）。参数：path（路径）、content（内容）',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要写入的文件路径' },
      content: { type: 'string', description: '文件内容' },
    },
    required: ['path', 'content'],
  },
  execute: async (args) => {
    const p = vfs.writeFile(args.path, args.content, 'write_file')
    return `wrote ${p} (${String(args.content).length} chars)`
  },
}

// ─── 3. edit：局部替换——old_string 必须唯一匹配，否则报错 ─────────────
/** edit：局部字符串替换（精确匹配 + 唯一性校验） */
const edit = {
  name: 'edit',
  description: '编辑虚拟文件：精确替换一段文本。参数：path、old_string、new_string。old_string 必须在文件中唯一匹配，否则报错。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要编辑的文件路径' },
      old_string: { type: 'string', description: '要被替换的文本（必须唯一匹配）' },
      new_string: { type: 'string', description: '替换后的文本' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute: async (args) => {
    const { path, old_string, new_string } = args
    const p = vfs.normalizePath(path)
    const content = vfs.readFile(path) // 不存在时抛错，agent 会转成 error 结果给模型
    const count = content.split(old_string).length - 1
    if (count === 0) throw new Error(`old_string not found in ${p}`)
    if (count > 1) throw new Error(`old_string matches ${count} places in ${p}, must be unique`)
    // 用函数替换避免 new_string 中的 $ 特殊字符（$& $` $' $1）被 String.replace 解释
    vfs.writeFile(path, content.replace(old_string, () => new_string), 'edit')
    return `edited ${p}: replaced ${old_string.length} chars`
  },
}

// ─── 4. run_js：沙盒里真执行 JS——"执行验证"是 coding agent 的灵魂能力 ──
/** run_js：在浏览器沙盒里执行一个 JS 文件，返回全部 console 输出 */
const runJs = {
  name: 'run_js',
  description: '在沙盒中执行一个 JS 文件（支持 require("./xxx.js") 相对引用，CommonJS 风格），返回所有 console 输出。用来运行测试验证修改。参数：path（如 test.js）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要执行的 JS 文件路径' },
    },
    required: ['path'],
  },
  execute: async (args, signal) => {
    if (signal && signal.aborted) return 'aborted'
    return vfs.runJs(args.path)
  },
}

// ─── 5. builtinTools：工具注册表——agent 拿到的能力清单 ────────────────
/** 返回全部内置工具 */
export function builtinTools() {
  return [readFile, writeFile, edit, runJs]
}
