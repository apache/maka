// scripts/smoke.mjs —— 零依赖冒烟测试：验证 vfs 虚拟文件系统与 run_js 沙盒。
// 不碰 DOM 和网络，只测纯逻辑；浏览器 UI 部分靠人工验收。
// 运行：npm test（或 node scripts/smoke.mjs）

import * as vfs from '../src/web-utils/vfs.js'

let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log('PASS ' + name)
  } else {
    failed++
    console.log('FAIL ' + name + (extra ? ' — ' + extra : ''))
  }
}

// 1. 路径规范化
check('normalizePath("./a/../b.js") → b.js', vfs.normalizePath('./a/../b.js') === 'b.js')
check('normalizePath("/root/x.js") → root/x.js', vfs.normalizePath('/root/x.js') === 'root/x.js')
check('normalizePath("..\\..\\x") → x（越过根即忽略）', vfs.normalizePath('..\\..\\x') === 'x')

// 2. 预置项目与初始失败状态
vfs.resetSandbox()
check('预置 3 个文件', vfs.listFiles().length === 3, vfs.listFiles().join(','))
const out1 = vfs.runJs('test.js')
check('初始 test.js 恰好 1 条失败', out1.includes('FAIL subtract(5, 3)') && out1.includes('1 TEST(S) FAILED'), JSON.stringify(out1))

// 3. require 解析与缓存
check('直接跑库文件无输出', vfs.runJs('./math.js') === '(no output)', JSON.stringify(vfs.runJs('./math.js')))
check('裸模块名自动补 .js', (() => {
  vfs.writeFile('req-test.js', 'var m = require("math.js")\nconsole.log(m.add(1, 2))')
  return vfs.runJs('req-test.js').trim() === '3'
})())

// 4. 完整任务闭环：读 → 改 → 验证（把 agent 将要走的路先走一遍）
const src = vfs.readFile('math.js')
const oldStr = 'function subtract(a, b) {\n  return a + b\n}'
check('bug 代码可唯一定位', src.split(oldStr).length - 1 === 1)
vfs.writeFile('math.js', src.replace(oldStr, 'function subtract(a, b) {\n  return a - b\n}'))
const out2 = vfs.runJs('test.js')
check('修复后全部通过', out2.includes('ALL TESTS PASSED'), JSON.stringify(out2))

// 5. 错误路径
check('执行不存在的文件报 file not found', vfs.runJs('nope.js').includes('file not found'))
vfs.writeFile('boom.js', 'console.log("before")\nthrow new Error("boom")')
const outErr = vfs.runJs('boom.js')
check('运行时错误被捕获且保留已打印内容', outErr.includes('before') && outErr.includes('[runtime error] boom'), JSON.stringify(outErr))
check('读取不存在的文件抛错（供 agent 转 error 结果）', (() => {
  try { vfs.readFile('ghost.js'); return false } catch { return true }
})())

// 6. 版本史（期4 diff 视图的数据源）
vfs.resetSandbox()
check('预置文件版本史只有基线', vfs.getHistory('math.js').length === 1 && vfs.getHistory('math.js')[0].tool === 'preset')
vfs.writeFile('math.js', 'v1', 'edit')
vfs.writeFile('math.js', 'v2', 'write_file')
const hist = vfs.getHistory('math.js')
check('每次写入追加版本且带工具标注', hist.length === 3 && hist[1].tool === 'edit' && hist[2].tool === 'write_file')
check('读当前内容仍是最后一版', vfs.readFile('math.js') === 'v2')
vfs.writeFile('brand-new.js', 'hello', 'write_file')
const histNew = vfs.getHistory('brand-new.js')
check('新文件以空内容为基线（diff 全绿）', histNew.length === 2 && histNew[0].content === '' && histNew[0].tool === 'init' && histNew[1].content === 'hello')

// 汇总（模仿沙盒 test.js 的输出风格，算是首尾呼应）
if (failed === 0) {
  console.log('ALL SMOKE TESTS PASSED')
} else {
  console.log(failed + ' SMOKE TEST(S) FAILED')
  process.exit(1)
}
