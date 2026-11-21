/**
 * 实践复盘对话：DeepSeek 流式 SSE（无工具回路，纯解读型）。
 * 上下文 = 预聚合统计 + 全部提交清单（一次性注入）；口径是统计先行、模型只做模式归纳。
 */

import {
  PracticeChatRequestSchema,
  type PracticeCommit,
  type PracticeStats,
} from '@ggbdpq/console-shared'
import { createDeepSeekClient, type ChatMessage, type LlmClient } from '@/server/todo/agent/llm'
import { getPracticeDb, loadCommits, loadMeta } from './db'
import { computeStats } from './stats'

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

function envFromProcess() {
  return {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '',
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    PORT: 0, // Env 类型含 PORT（todo 域遗留），本域不消费
  }
}

function shortDate(iso: string): string {
  return iso.slice(5, 10) // MM-DD
}

/** 仓库短名：去 homing-miniapp-/homing- 前缀，beauty-smart-advisor → advisor */
function repoAliasOf(repo: string): string {
  return repo
    .replace(/^beauty-smart-advisor$/, 'advisor')
    .replace(/^homing-miniapp-/, '')
    .replace(/^homing-/, '')
}

/** 提交清单压缩为逐行文本（控制 token：类型单字母 + 日期 + 仓库短名 + 标题） */
function renderCommits(commits: PracticeCommit[]): string {
  return commits
    .map((c) => {
      const t = c.type === 'pr' ? 'F' : c.type === 'issue' ? 'B' : 'O'
      const scope = c.files.slice(0, 3).map((f) => f.path).join(',')
      return `${shortDate(c.authoredAt)} ${t} ${repoAliasOf(c.repo)} ${c.subject}${scope && c.type === 'issue' ? `  [${scope}]` : ''}`
    })
    .join('\n')
}

function renderStats(stats: PracticeStats): string {
  const lines: string[] = []
  lines.push(`总提交 ${stats.total}；功能(F) ${stats.byType.pr}，缺陷修复(B) ${stats.byType.issue}，其他(O) ${stats.byType.other}`)
  lines.push('按仓库：' + stats.byRepo.map((r) => `${r.repo}=${r.total}(F${r.byType.pr}/B${r.byType.issue}/O${r.byType.other})`).join('，'))
  lines.push('按周：' + stats.weekly.map((w) => `${w.weekStart.slice(5)}周=${w.total}(B${w.issue})`).join('，'))
  const cluster = (title: string, items: PracticeStats['topFixScopes']) => {
    if (items.length) lines.push(title + '：' + items.map((c) => `${c.key}×${c.count}`).join('，'))
  }
  cluster('修复 scope 聚类 Top10', stats.topFixScopes)
  cluster('修复目录聚类 Top10', stats.topFixDirs)
  cluster('反复修改文件 Top10', stats.topFixFiles)
  return lines.join('\n')
}

export function buildSystemPrompt(commits: PracticeCommit[], stats: PracticeStats, window: { since: string; until: string }): string {
  return [
    '你是一位资深前端工程导师，帮助开发者复盘自己的 git 提交历史，找出反复出现的模式与可改进点。',
    '数据是一位开发者（关天豪）在公司项目中的全部提交（已按作者过滤、排除 merge 提交）。类型标记：F=功能新增（相当于 PR），B=缺陷修复（相当于 Issue），O=其他改动。',
    `统计窗口：${window.since} 至 ${window.until.slice(0, 10)}。`,
    '',
    '== 预聚合统计 ==',
    renderStats(stats),
    '',
    '== 全部提交清单（日期 类型 仓库 标题；B 类附主要文件路径）==',
    renderCommits(commits),
    '',
    '回答要求：',
    '1. 用简体中文，结论先行，引用具体提交标题或文件路径作为证据，不编造数据里不存在的内容。',
    '2. 分析「反复犯的错误」时优先看：同一 scope/目录/文件被反复修复的模式、B 类在时间上的聚集、功能与修复的比例。',
    '3. 给出可执行的改进建议（流程、测试、代码习惯层面），不要空泛说教。',
    '4. 数据未覆盖的问题（如具体代码内容）明确说明推测性质。',
  ].join('\n')
}

/** POST /api/practice/chat 主体：返回 SSE Response */
export function handlePracticeChat(body: unknown, signal?: AbortSignal, llm?: LlmClient): Response {
  let input: { message: string }
  try {
    input = PracticeChatRequestSchema.parse(body)
  } catch {
    return Response.json({ code: 'VALIDATION_ERROR', message: 'message 不能为空且不超过 4000 字' }, { status: 400 })
  }

  const db = getPracticeDb()
  const commits = loadCommits(db)
  if (commits.length === 0) {
    return Response.json({ code: 'NO_DATA', message: '还没有同步数据，请先点击「同步提交」' }, { status: 409 })
  }
  const window = {
    since: loadMeta(db, 'window_since') ?? '',
    until: loadMeta(db, 'window_until') ?? '',
  }
  const client = llm ?? createDeepSeekClient(envFromProcess())
  if (!process.env.DEEPSEEK_API_KEY && !llm) {
    return Response.json({ code: 'NO_API_KEY', message: '未配置 DEEPSEEK_API_KEY 环境变量' }, { status: 500 })
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(commits, computeStats(commits), window) },
    { role: 'user', content: input.message },
  ]

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (event: { type: string; [k: string]: unknown }) => {
        if (closed) return
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      try {
        for await (const chunk of client.streamChat({ messages, withTools: false, signal })) {
          if (chunk.text) send({ type: 'delta', text: chunk.text })
        }
        send({ type: 'done' })
      } catch (err) {
        if (!signal?.aborted) {
          send({
            type: 'error',
            code: 'LLM_ERROR',
            message: err instanceof Error ? err.message : '模型调用失败',
          })
        }
      } finally {
        if (!closed) {
          closed = true
          try {
            controller.close()
          } catch {
            // 已关闭
          }
        }
      }
    },
    cancel() {
      // 消费方断开即中止上游生成
    },
  })
  return new Response(stream, { headers: SSE_HEADERS })
}
