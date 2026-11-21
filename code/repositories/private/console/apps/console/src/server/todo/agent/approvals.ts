import type { ApprovalStatus } from '@ggbdpq/console-shared/todo'

/** Q21 定案：确认超时 120s，超时作为 tool 结果回给模型（不猝死） */
export const CONFIRM_TIMEOUT_MS = 120_000

export interface ApprovalOutcome {
  approved: boolean
  status: ApprovalStatus
}

interface Pending {
  resolve: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

const key = (messageId: number, toolCallId: string) => `${messageId}:${toolCallId}`

/**
 * 写确认注册表（Q15 定案：SSE 长连接悬挂等待 + 独立 POST 端点 resolve）。
 * agent loop 在 wait() 挂起；confirm 路由调 resolve()；断线调 cancelAll() 防泄漏。
 */
export class ApprovalRegistry {
  private pending = new Map<string, Pending>()

  constructor(private readonly defaultTimeoutMs: number = CONFIRM_TIMEOUT_MS) {}

  /** 挂起等待用户确认；超时以 { approved:false, status:'timeout' } 兑现 */
  wait(messageId: number, toolCallId: string, timeoutMs = this.defaultTimeoutMs): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key(messageId, toolCallId))
        resolve({ approved: false, status: 'timeout' })
      }, timeoutMs)
      this.pending.set(key(messageId, toolCallId), { resolve, timer })
    })
  }

  /** confirm 路由调用；返回 false 表示没有对应的挂起确认（已超时或不属于该消息） */
  resolve(messageId: number, toolCallId: string, approved: boolean): boolean {
    const k = key(messageId, toolCallId)
    const p = this.pending.get(k)
    if (!p) return false
    clearTimeout(p.timer)
    this.pending.delete(k)
    p.resolve({ approved, status: approved ? 'confirmed' : 'rejected' })
    return true
  }

  /** 断线清理：把该消息的所有挂起确认立即兑现为 rejected，避免悬挂 promise */
  cancelAll(messageId: number): void {
    const prefix = `${messageId}:`
    for (const [k, p] of this.pending) {
      if (k.startsWith(prefix)) {
        clearTimeout(p.timer)
        this.pending.delete(k)
        p.resolve({ approved: false, status: 'rejected' })
      }
    }
  }
}
