// scripts/diff-test.mjs —— js/diff.js 的无头测试（纯函数，不碰 DOM）。
// 覆盖：相同文本、单行修改、插入、删除、新文件（空基线全绿）、hunk 分块与合并。
// 运行：node scripts/diff-test.mjs（npm test 会自动带上）

import { diffOps, diffHunks, diffToText } from '../src/web-utils/diff.js'

let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log('PASS ' + name)
  } else {
    failed++
    console.log('FAIL ' + name + (extra ? ' — ' + extra : ''))
  }
}

const lines = (arr) => arr.join('\n')

// ===== 1. 相同文本：全部 same，无 hunk =====
{
  const text = lines(['a', 'b', 'c'])
  const ops = diffOps(text, text)
  check('相同文本：全部 same', ops.length === 3 && ops.every((op) => op.type === 'same'))
  check('相同文本：零 hunk', diffHunks(text, text).length === 0)
}

// ===== 2. 修 bug 场景：subtract 里 a+b → a-b（正好一个 del 一个 add） =====
{
  const before = lines([
    'function add(a, b) {',
    '  return a + b',
    '}',
    '',
    'function subtract(a, b) {',
    '  return a + b',
    '}',
  ])
  const after = lines([
    'function add(a, b) {',
    '  return a + b',
    '}',
    '',
    'function subtract(a, b) {',
    '  return a - b',
    '}',
  ])
  const ops = diffOps(before, after)
  const dels = ops.filter((op) => op.type === 'del')
  const adds = ops.filter((op) => op.type === 'add')
  check('单行修改：恰好 1 删 1 增', dels.length === 1 && adds.length === 1, JSON.stringify(ops.filter((o) => o.type !== 'same')))
  check('单行修改：删的是旧行、增的是新行', dels[0].text === '  return a + b' && adds[0].text === '  return a - b')
  const text = diffToText(before, after)
  check('文本版 diff 含 +/- 标记', text.includes('-  return a + b') && text.includes('+  return a - b'), text)
}

// ===== 3. 纯插入与纯删除 =====
{
  const base = lines(['a', 'b', 'c'])
  const inserted = lines(['a', 'b', 'NEW', 'c'])
  const ops = diffOps(base, inserted)
  check('插入：1 个 add、0 个 del', ops.filter((o) => o.type === 'add').length === 1 && ops.filter((o) => o.type === 'del').length === 0)
  check('插入：新增行内容正确', ops.find((o) => o.type === 'add').text === 'NEW')

  const removed = lines(['a', 'c'])
  const ops2 = diffOps(base, removed)
  check('删除：1 个 del、0 个 add', ops2.filter((o) => o.type === 'del').length === 1 && ops2.filter((o) => o.type === 'add').length === 0)
  check('删除：删掉的行内容正确', ops2.find((o) => o.type === 'del').text === 'b')
}

// ===== 4. 新文件（空基线 → 全部是 add） =====
{
  const content = lines(['hello', 'world'])
  const hunks = diffHunks('', content)
  const flat = hunks.flatMap((h) => h.ops)
  check('空基线：所有行都是 add', flat.length === 2 && flat.every((op) => op.type === 'add'))
}

// ===== 5. hunk 分块：远处两处改动 → 2 块；近处改动按上下文合并 =====
{
  const before = lines(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
  const farChanged = lines(['X', '2', '3', '4', '5', '6', '7', '8', '9', 'Y'])
  check('远处两处改动切成 2 个 hunk', diffHunks(before, farChanged).length === 2, JSON.stringify(diffHunks(before, farChanged)))

  const near = lines(['1', '2', '3', '4', '5'])
  const nearChanged = lines(['X', '2', 'Y', '4', '5']) // 隔 1 行的两处改动
  check('近处改动按上下文合并为 1 个 hunk', diffHunks(near, nearChanged, 2).length === 1)
  check('零上下文时刻开为 2 个 hunk', diffHunks(near, nearChanged, 0).length === 2)
}

// ===== 6. hunk 上下文：变化行前后各带 context 行 =====
{
  const before = lines(['1', '2', '3', '4', '5'])
  const after = lines(['1', '2', 'Z', '4', '5'])
  const hunks = diffHunks(before, after, 2)
  const texts = hunks.length === 1 ? hunks[0].ops.map((op) => op.text) : []
  check(
    '上下文行进入 hunk',
    hunks.length === 1 && ['1', '2', '3', 'Z', '4', '5'].every((t) => texts.includes(t)),
    JSON.stringify(hunks)
  )
}

// 汇总
if (failed === 0) {
  console.log('ALL DIFF TESTS PASSED')
} else {
  console.log(failed + ' DIFF TEST(S) FAILED')
  process.exit(1)
}
