import { z } from 'zod'

/** 书签域错误码 */
export const ErrorCodeSchema = z.enum(['VALIDATION_ERROR', 'NOT_FOUND', 'CONFLICT', 'INTERNAL_ERROR'])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

/** 统一错误 envelope：所有非 2xx 响应的响应体 */
export const ErrorEnvelopeSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
})
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

/** 服务端构造错误时使用的异常类；route handler 经 serializeError 统一序列化 */
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
export const conflict = (message: string) => new ApiError(409, 'CONFLICT', message)
