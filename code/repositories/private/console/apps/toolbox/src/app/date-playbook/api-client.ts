import { coupleSchema, planSchema, proposalSchema, timelineEventSchema } from "@/schemas/date-playbook";
import { z } from "zod";

// 情侣空间聚合状态：前端一次拉全，动作走独立 POST

const stateSchema = z.object({
  couple: coupleSchema.nullable(),
  plans: z.array(planSchema),
  proposals: z.array(proposalSchema),
  timeline: z.array(timelineEventSchema),
});
export type DatePlaybookState = z.infer<typeof stateSchema>;
export const datePlaybookStateSchema = stateSchema;

export async function fetchState(userId: string): Promise<DatePlaybookState> {
  const res = await fetch(`/api/date-playbook/state?userId=${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error("加载失败");
  return stateSchema.parse(await res.json());
}

async function post<T>(url: string, body: unknown, parse: (v: unknown) => T): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as unknown;
  if (!res.ok) {
    const message = typeof json === "object" && json && "error" in json ? String((json as { error: unknown }).error) : "操作失败";
    throw new Error(message);
  }
  return parse(json);
}
