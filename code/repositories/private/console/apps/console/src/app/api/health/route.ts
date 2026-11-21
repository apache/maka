import { NextResponse } from "next/server";
import { healthResponseSchema } from "@ggbdpq/console-shared";

// 全 API 层的最简契约端点：CLI doctor 与冒烟验证依赖它。
// 约定：所有 Route Handler 的响应体都从 packages/shared 的 schema parse 产生。
export async function GET() {
  const body = healthResponseSchema.parse({
    ok: true,
    service: "console",
    time: new Date().toISOString(),
  });
  return NextResponse.json(body);
}
