// scripts/pump-test.mjs —— EventPump 油门的无头测试（不碰 DOM，不碰网络）。
// 用假 generator 模拟 agent 事件流，验证断点系统的核心语义：
// 自动播放 / 断点扣住 / 单步（含事件在路上时的排队单步）/ 轮边界 / forceAuto。
// 运行：node scripts/pump-test.mjs（npm test 会自动带上）

import { EventPump } from '../src/web-utils/pump.js'

let failed = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log('PASS ' + name)
  } else {
    failed++
    console.log('FAIL ' + name + (extra ? ' — ' + extra : ''))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(condFn, timeout = 1000) {
  const t0 = Date.now()
  while (!condFn()) {
    if (Date.now() - t0 > timeout) throw new Error('until 超时')
    await sleep(10)
  }
}

const SRC = { file: 'x.js', fn: 'f' }
const EVENTS = [
  { type: 'assistant_text', delta: '你', src: SRC },
  { type: 'assistant_text', delta: '好', src: SRC },
  { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'math.js' }, src: SRC },
  { type: 'tool_result', id: 'c1', name: 'read_file', result: 'ok', src: SRC },
  { type: 'assistant_text', delta: '修好了', src: SRC },
  { type: 'turn_end', stopReason: 'end_turn', src: SRC },
]

async function* fakeGen() {
  for (const ev of EVENTS) yield ev
}

async function* slowGen() {
  for (const ev of EVENTS) { await sleep(15); yield ev }
}

function makePump(gen, rec) {
  const pump = new EventPump(gen, {
    onEvent: (ev, i) => rec.events.push({ i, type: ev.type }),
    onHold: (ev, reason) => rec.holds.push({ type: ev.type, reason }),
    onDone: () => { rec.done = true },
  })
  return pump
}

const mkRec = () => ({ events: [], holds: [], done: false })

// ===== 1. 自动播放：全放行、不扣、顺序保持 =====
{
  const rec = mkRec()
  const pump = makePump(fakeGen(), rec)
  pump.start()
  await until(() => rec.done)
  check('自动播放：6 个事件全放行', rec.events.length === 6, JSON.stringify(rec.events))
  check('自动播放：顺序与序号保持', rec.events.every((e, idx) => e.i === idx + 1 && e.type === EVENTS[idx].type))
  check('自动播放：零扣住', rec.holds.length === 0)
}

// ===== 2. 断点 tool_call：命中即停，play 后走完 =====
{
  const rec = mkRec()
  const pump = makePump(fakeGen(), rec)
  pump.breakpoints.add('tool_call')
  pump.start()
  await until(() => rec.holds.length === 1)
  check('断点 tool_call：前 2 个事件已放行', rec.events.length === 2, JSON.stringify(rec.events))
  check('断点 tool_call：扣住的是 tool_call', rec.holds[0].type === 'tool_call')
  check('断点命中原因文案', rec.holds[0].reason === '断点命中：tool_call', rec.holds[0].reason)
  pump.play()
  await until(() => rec.done)
  check('断点放行后走完全程', rec.events.length === 6 && rec.holds.length === 1)
}

// ===== 3. 暂停 + 单步：一次恰好放行一个 =====
{
  const rec = mkRec()
  const pump = makePump(fakeGen(), rec)
  pump.pause()
  pump.start()
  await until(() => rec.holds.length === 1)
  check('暂停：第一个事件被扣住', rec.holds[0].type === 'assistant_text' && rec.events.length === 0)
  check('暂停原因文案', rec.holds[0].reason === '已暂停')
  pump.step()
  await until(() => rec.events.length === 1)
  check('单步 1：恰好放行一个', rec.events[0].type === 'assistant_text')
  await until(() => rec.holds.length === 2) // 下一个事件随即扣住
  pump.step()
  await until(() => rec.events.length === 2)
  check('单步 2：再放行一个', rec.events[1].type === 'assistant_text')
  // 每放行一个事件，下一个随即被扣住：2 个已放行 ⇒ 3 次扣住（1、2 号事件 + 3 号在押）
  await until(() => rec.holds.length === 3)
  check('单步节奏：每放行一个，下一个即扣住', rec.events.length === 2 && rec.holds.length === 3)
  pump.forceAuto()
  await until(() => rec.done)
  check('forceAuto 收尾：走完全程', rec.events.length === 6)
}

// ===== 4. 排队单步：事件还在路上时点单步，到达即放行一个 =====
{
  const rec = mkRec()
  const pump = makePump(slowGen(), rec)
  pump.pause()
  pump.start()
  pump.step() // 此刻还没有被扣事件——单步应排队
  await until(() => rec.events.length === 1)
  check('排队单步：第一个事件到达即放行', rec.events.length === 1 && rec.holds.length === 0, JSON.stringify(rec))
  await until(() => rec.holds.length === 1) // 第二个事件正常扣住
  check('排队单步：后续事件恢复扣住', rec.holds[0].type === 'assistant_text')
  pump.forceAuto()
  await until(() => rec.done)
  check('排队单步收尾完整', rec.events.length === 6)
}

// ===== 5. 轮边界断点：回合首事件前 + tool_result 后新轮前 =====
{
  const rec = mkRec()
  const pump = makePump(fakeGen(), rec)
  pump.breakpoints.add('round_start')
  pump.start()
  await until(() => rec.holds.length === 1)
  check('轮边界：回合第一个事件前扣住', rec.holds[0].type === 'assistant_text' && rec.events.length === 0)
  pump.play()
  await until(() => rec.holds.length === 2)
  check('轮边界：tool_result 后新轮前扣住', rec.holds[1].type === 'assistant_text' && rec.events.length === 4, JSON.stringify(rec.events))
  pump.play()
  await until(() => rec.done)
  check('轮边界：全程恰好命中 2 次', rec.holds.length === 2 && rec.events.length === 6)
}

// ===== 6. forceAuto 在扣住状态直接放行（停止按钮语义） =====
{
  const rec = mkRec()
  const pump = makePump(fakeGen(), rec)
  pump.breakpoints.add('tool_call')
  pump.start()
  await until(() => rec.holds.length === 1)
  pump.forceAuto()
  await until(() => rec.done)
  check('forceAuto：从断点直通到底', rec.events.length === 6 && rec.holds.length === 1)
}

// ===== 7. compact_end 可断点；压缩后的新轮触发轮边界（期6） =====
{
  const compactEvents = [
    { type: 'tool_result', id: 'c1', name: 'edit', result: 'ok', src: SRC },
    { type: 'compact_start', count: 52, src: SRC },
    { type: 'compact_end', summary: '旧消息摘要', removed: 32, kept: 20, src: SRC },
    { type: 'assistant_text', delta: '继续', src: SRC },
    { type: 'turn_end', stopReason: 'end_turn', src: SRC },
  ]
  async function* compactGen() {
    for (const ev of compactEvents) yield ev
  }
  const rec = mkRec()
  const pump = makePump(compactGen(), rec)
  pump.breakpoints.add('compact_end')
  pump.breakpoints.add('round_start')
  pump.start()
  await until(() => rec.holds.length === 1)
  check('compact_end 断点：前两个事件已放行', rec.events.length === 2 && rec.holds[0].type === 'compact_end', JSON.stringify(rec.events))
  pump.play()
  await until(() => rec.holds.length === 2)
  check('压缩后 assistant_text 触发轮边界', rec.holds[1].reason === '断点命中：round_start' && rec.holds[1].type === 'assistant_text', JSON.stringify(rec.holds))
  pump.play()
  await until(() => rec.done)
  check('compact 场景收尾完整', rec.events.length === 5 && rec.holds.length === 2)
}

// 汇总
if (failed === 0) {
  console.log('ALL PUMP TESTS PASSED')
} else {
  console.log(failed + ' PUMP TEST(S) FAILED')
  process.exit(1)
}
