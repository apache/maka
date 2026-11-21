import type { PlanStatus } from "@/schemas/date-playbook";

// 迁移自 date-playbook-miniapp domain/plan/statusMachine.ts
// draft → pending_confirmation → confirmed → completed / cancelled
// pending_confirmation 可被对方退回 draft（需填写原因，由调用方保证）

const TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  draft: ["pending_confirmation", "cancelled"],
  pending_confirmation: ["confirmed", "draft", "cancelled"],
  confirmed: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransition(from: PlanStatus, to: PlanStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PlanStatus, to: PlanStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`非法的计划状态变更：${from} → ${to}`);
  }
}

export { PLAN_STATUS_LABELS } from "@/schemas/date-playbook";
