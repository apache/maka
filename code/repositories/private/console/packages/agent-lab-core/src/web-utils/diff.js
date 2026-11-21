// js/diff.js —— 极简行级 diff：LCS（最长公共子序列）动态规划 + unified diff 风格分块。
// 纯函数、零依赖、不碰 DOM——可以在 Node 里无头测试（scripts/diff-test.mjs）。
// 沙盒文件都是几十行的量级，O(n·m) 的 DP 表绰绰有余，没必要上 Myers 算法。
//
// 阅读路线：diffOps()（求差异操作序列）→ diffHunks()（切成带上下文的块）→ diffToText()（调试用文本版）。

/**
 * 计算两个文本的行级差异，返回按顺序的操作序列：
 * [{ type: 'same' | 'del' | 'add', text: '该行内容' }]
 * - same：两版都有这一行
 * - del：只有旧版有（渲染成红色 −）
 * - add：只有新版有（渲染成绿色 +）
 */
export function diffOps(aText, bText) {
  // 空串视为零行（''.split('\n') 会得到一个空行，新文件的 diff 就会多出一条无意义的 −）
  const a = aText === '' ? [] : String(aText).split('\n')
  const b = bText === '' ? [] : String(bText).split('\n')
  const n = a.length
  const m = b.length

  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度（从尾部倒着推）
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // 回溯：行相同走 same；不同先删旧行（del）再加新行（add）——与真实 diff 工具的输出习惯一致
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i] })
      i++
    } else {
      ops.push({ type: 'add', text: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] })
  while (j < m) ops.push({ type: 'add', text: b[j++] })
  return ops
}

/**
 * 把操作序列切成若干 hunk（变化块），每块带 context 行不变的上下文——
 * 就像 git diff 的 @@ 块：只看变化附近，而不是整份文件。
 * 间隔 ≤ 2*context 的两个变化会自然并进同一个 hunk（它们的上下文重叠了）。
 */
export function diffHunks(aText, bText, context = 2) {
  const ops = diffOps(aText, bText)
  const len = ops.length

  // dist[k] = 第 k 行到最近一个变化行的距离（前后各扫一遍）
  const dist = new Array(len).fill(Infinity)
  let d = Infinity
  for (let k = 0; k < len; k++) {
    d = ops[k].type !== 'same' ? 0 : d + 1
    dist[k] = d
  }
  d = Infinity
  for (let k = len - 1; k >= 0; k--) {
    d = ops[k].type !== 'same' ? 0 : d + 1
    dist[k] = Math.min(dist[k], d)
  }

  // 距离 ≤ context 的行属于某个 hunk；连续段即一个块
  const hunks = []
  let k = 0
  while (k < len) {
    if (dist[k] > context) {
      k++
      continue
    }
    const from = k
    while (k < len && dist[k] <= context) k++
    hunks.push({ from, to: k, ops: ops.slice(from, k) })
  }
  return hunks
}

/** 调试/测试用的纯文本版：+ 前缀新增、- 前缀删除、空格前缀上下文 */
export function diffToText(aText, bText) {
  return diffHunks(aText, bText)
    .map((h) => h.ops.map((op) => (op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ') + op.text).join('\n'))
    .join('\n@@\n')
}
