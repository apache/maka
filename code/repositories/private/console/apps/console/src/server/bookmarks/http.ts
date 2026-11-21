import { ZodType } from 'zod'
import { ApiError, type ErrorEnvelope } from '@ggbdpq/console-shared/bookmarks'

/** 请求负载校验入口：失败统一抛 VALIDATION_ERROR envelope */
export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      first ? `${first.path.join('.') || 'body'}: ${first.message}` : '请求体不合法',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    )
  }
  return result.data
}

/** 统一错误序列化：所有非 2xx 响应都是 ErrorEnvelope 形态 */
export function serializeError(err: unknown): { statusCode: number; body: ErrorEnvelope } {
  if (err instanceof ApiError) {
    return {
      statusCode: err.statusCode,
      body: { code: err.code, message: err.message, details: err.details },
    }
  }
  return {
    statusCode: 500,
    body: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : '服务端内部错误' },
  }
}
