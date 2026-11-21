import { z } from 'zod'

/**
 * 浏览器侧统一 fetch 封装（与 packages/shared 的服务端 ErrorEnvelope 同形）：
 * JSON 序列化 + 非 2xx 解包错误封套并抛 ApiRequestError。
 * 各域 client 以 re-export 方式消费，禁止再手写裸 fetch + 静默吞错。
 */

const ErrorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
})

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiRequestError'
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })

  if (!res.ok) {
    const raw = await res.json().catch(() => null)
    const envelope = raw ? ErrorEnvelopeSchema.safeParse(raw) : null
    if (envelope?.success) {
      throw new ApiRequestError(envelope.data.code, envelope.data.message, res.status, envelope.data.details)
    }
    throw new ApiRequestError('INTERNAL_ERROR', `请求失败（HTTP ${res.status}）`, res.status)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
