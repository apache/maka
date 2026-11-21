import { z } from "zod";

// 健康检查响应：全 API 的最简契约，也是 API 层"真 HTTP"约定的样例。
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  // 多 app 各自的 health 端点共用此契约：console(65501) / agent(65504)
  service: z.enum(["console", "agent"]),
  time: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
