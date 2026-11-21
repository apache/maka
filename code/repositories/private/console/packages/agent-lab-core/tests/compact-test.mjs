// scripts/compact-test.mjs —— js/agent.js 里 compactContext 的无头测试。
// compactContext 依赖 LLM 网络调用，靠 streamFn 注入参数换上假 LLM（期6 决策：
// 留在 agent.js 对照 TS 版保真，export + 注入换可测性）。
// 覆盖共识定的 5 场景：不到阈值不动 / 到阈值替换且保留近期 / 失败不替换 /
// abort 不压 / 空摘要不压，外加 aborted stopReason 一支。
// 运行：node scripts/compact-test.mjs（npm test 会自动带上）

import { compactContext } from '../src/agent.js'

let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log('PASS ' + name)
  } else {
    failed++
    console.log('FAIL ' + name + (extra ? ' — ' + extra : ''))
  }
}

// ===== 假 LLM（注入用） =====

async function* fakeOk() {
  yield { type: 'text_delta', delta: '用户要求修 math.js，' }
  yield { type: 'text_delta', delta: 'subtract 的 bug 已修复，测试全过。' }
  yield { type: 'done', stopReason: 'end_turn' }
}
async function* fakeErr() {
  yield { type: 'error', error: new Error('boom') }
}
async function* fakeEmpty() {
  yield { type: 'done', stopReason: 'end_turn' } // 正常结束但一个字没说
}
async function* fakeAborted() {
  yield { type: 'done', stopReason: 'aborted' }
}

/** 造 n 条消息的 context；最后一条内容带编号，供"保留近期"断言用 */
function mkContext(n) {
  return {
    systemPrompt: 'sys',
    messages: Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `msg-${i}` })),
  }
}

const MODEL = { apiKey: 'x', model: 'fake' }

// ===== 1. 不到阈值：不动 =====
{
  const ctx = mkContext(10)
  let calls = 0
  const r = await compactContext(MODEL, ctx, undefined, { threshold: 50, streamFn: async function* () { calls++ } })
  check('不到阈值返回 null', r === null)
  check('不到阈值不调 LLM', calls === 0)
  check('不到阈值消息原样', ctx.messages.length === 10)
}

// ===== 2. 到阈值：替换 + 保留近期 =====
{
  const ctx = mkContext(30)
  const r = await compactContext(MODEL, ctx, undefined, { threshold: 20, keepRecent: 5, streamFn: fakeOk })
  check('返回摘要与统计', r && r.removed === 25 && r.kept === 5, JSON.stringify(r))
  check('消息变为 摘要1条 + 近期5条', ctx.messages.length === 6)
  check('首条是 [context summary] user message',
    ctx.messages[0].role === 'user' && ctx.messages[0].content.startsWith('[context summary]\n'))
  check('摘要内容来自假 LLM', ctx.messages[0].content.includes('subtract 的 bug 已修复'))
  check('近期消息原样保留（尾部 5 条）', ctx.messages.slice(1).every((m, i) => m.content === `msg-${25 + i}`))
}

// ===== 3. LLM 出错：不替换 =====
{
  const ctx = mkContext(30)
  const r = await compactContext(MODEL, ctx, undefined, { threshold: 20, streamFn: fakeErr })
  check('LLM 出错返回 null', r === null)
  check('LLM 出错消息原样（30 条）', ctx.messages.length === 30)
}

// ===== 4. abort 信号：不压 =====
{
  const ctx = mkContext(30)
  const ctrl = new AbortController()
  ctrl.abort()
  let calls = 0
  const r = await compactContext(MODEL, ctx, ctrl.signal, { threshold: 20, streamFn: async function* () { calls++ } })
  check('abort 返回 null', r === null)
  check('abort 不调 LLM', calls === 0)
  check('abort 消息原样', ctx.messages.length === 30)
}

// ===== 5. 空摘要：不替换 =====
{
  const ctx = mkContext(30)
  const r = await compactContext(MODEL, ctx, undefined, { threshold: 20, streamFn: fakeEmpty })
  check('空摘要返回 null', r === null)
  check('空摘要消息原样', ctx.messages.length === 30)
}

// ===== 6. 流内 aborted stopReason：不替换（三重失败保护第三支） =====
{
  const ctx = mkContext(30)
  const r = await compactContext(MODEL, ctx, undefined, { threshold: 20, streamFn: fakeAborted })
  check('aborted stopReason 返回 null', r === null)
  check('aborted stopReason 消息原样', ctx.messages.length === 30)
}

// ===== 7. 传给 compactContext 的旧消息内容确为序列化全文 =====
{
  let seen = null
  async function* spy(model, summaryContext) {
    seen = summaryContext.messages[0].content
    yield { type: 'text_delta', delta: 'ok' }
    yield { type: 'done', stopReason: 'end_turn' }
  }
  const ctx = mkContext(22)
  await compactContext(MODEL, ctx, undefined, { threshold: 20, keepRecent: 5, streamFn: spy })
  check('LLM 收到旧消息序列化文本', seen && seen.includes('user: msg-0') && seen.includes('assistant: msg-1'), JSON.stringify(seen && seen.slice(0, 60)))
}

// 汇总
if (failed === 0) {
  console.log('ALL COMPACT TESTS PASSED')
} else {
  console.log(failed + ' COMPACT TEST(S) FAILED')
  process.exit(1)
}
