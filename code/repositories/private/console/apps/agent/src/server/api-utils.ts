import { NextResponse } from "next/server";

// ponytail: 2026-09-19 AI 线收拢时自 console server/assets/api-utils 原样复制；第三个消费方出现时提取到共享包。
// 资产域 API 公共错误响应，对齐原 Hono 实现的 { error: string } 形态。
export function jsonError(msg: string, status = 400): NextResponse {
  return NextResponse.json({ error: msg }, { status });
}

// Next 16 动态路由参数都是 Promise，这里统一 await。
export async function param(ctx: { params: Promise<Record<string, string>> }, key: string): Promise<string> {
  const p = await ctx.params;
  return p[key] ?? "";
}

// 容错解析 JSON 请求体：空/坏 body 一律按 {} 处理，交给 zod 校验失败分支。
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
