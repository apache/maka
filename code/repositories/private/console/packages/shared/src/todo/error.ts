import { z } from 'zod'
import { ErrorCodeSchema, type ErrorCode } from './enums'

/** 统一错误 envelope：所有非 2xx 响应的响应体（Q9 定案） */
export const ErrorEnvelopeSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
})
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

/** 服务端构造错误时使用的异常类；Fastify error handler 统一序列化 */
export class ApiError extends Error {
  readonly statusCode: number
  readonly code: ErrorCode
  readonly details?: unknown

  constructor(statusCode: number, code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export const validationError = (message: string, details?: unknown) =>
  new ApiError(400, 'VALIDATION_ERROR', message, details)
export const notFound = (message: string) => new ApiError(404, 'NOT_FOUND', message)
