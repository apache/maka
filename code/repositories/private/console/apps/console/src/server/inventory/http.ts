import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { ZodError } from "zod";

// 与原 Fastify lib/http.ts 同语义的 Next 适配层。
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      first ? `${first.path.join(".") || "body"}: ${first.message}` : "请求体不合法",
    );
  }
  return result.data;
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// 统一错误映射：ApiError → 自带状态码；ZodError → 400；其余 → 500。
export async function handle(fn: () => unknown | Promise<unknown>): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data);
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json(
        { code: err.code, message: err.message, details: err.details },
        { status: err.statusCode },
      );
    }
    if (err instanceof ZodError) {
      return NextResponse.json(
        { code: "VALIDATION_ERROR", message: err.issues[0]?.message ?? "请求体不合法" },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "服务端内部错误";
    return NextResponse.json({ code: "INTERNAL_ERROR", message }, { status: 500 });
  }
}
