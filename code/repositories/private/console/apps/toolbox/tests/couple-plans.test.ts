import { describe, beforeAll, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  canTransition,
  PLAN_STATUS_LABELS,
} from "@/server/date-playbook/plan-machine";
import { createCoupleRepo } from "@/server/date-playbook/couple-repo";

describe("计划状态机（迁移自 plan/statusMachine）", () => {
  it("合法流转放行", () => {
    expect(canTransition("draft", "pending_confirmation")).toBe(true);
    expect(canTransition("pending_confirmation", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "completed")).toBe(true);
    expect(canTransition("confirmed", "cancelled")).toBe(true);
    expect(canTransition("pending_confirmation", "draft")).toBe(true);
  });
  it("非法流转拒绝", () => {
    expect(canTransition("draft", "completed")).toBe(false);
    expect(canTransition("completed", "cancelled")).toBe(false);
    expect(canTransition("cancelled", "draft")).toBe(false);
  });
  it("状态标签齐全", () => {
    expect(PLAN_STATUS_LABELS.draft).toBe("草稿");
  });
});

describe("couple+plans sqlite 仓库（内存库）", () => {
  let repo: ReturnType<typeof createCoupleRepo>;

  beforeAll(() => {
    repo = createCoupleRepo(new DatabaseSync(":memory:"));
  });

  it("创建情侣空间并双成员绑定，第三人被拒", () => {
    const couple = repo.createCouple("我们的小家", "user-a");
    expect(couple.memberIds).toContain("user-a");
    expect(couple.inviteCode).toMatch(/^\d{6}$/);
    const joined = repo.joinCouple(couple.inviteCode, "user-b");
    expect(joined.memberIds).toHaveLength(2);
    expect(() => repo.joinCouple(couple.inviteCode, "user-c")).toThrow();
  });

  it("计划生命周期 draft→待确认→确认→完成，非法跳变抛错", () => {
    const couple = repo.listCouples()[0];
    const plan = repo.createPlan(couple.id, "user-a", {
      title: "夜市散步",
      date: "2026-09-05",
      venueIds: ["venue-yes-market"],
    });
    expect(plan.status).toBe("draft");
    repo.transitionPlan(plan.id, "user-a", "pending_confirmation");
    expect(repo.getPlan(plan.id)?.status).toBe("pending_confirmation");
    expect(() => repo.transitionPlan(plan.id, "user-a", "completed")).toThrow();
    repo.transitionPlan(plan.id, "user-b", "confirmed");
    repo.transitionPlan(plan.id, "user-b", "completed");
    expect(repo.getPlan(plan.id)?.status).toBe("completed");
  });

  it("非成员写入共享数据被拒", () => {
    const couple = repo.listCouples()[0];
    expect(() => repo.createPlan(couple.id, "user-outsider", { title: "x", date: "2026-09-06", venueIds: ["v1"] })).toThrow();
  });

  it("复盘写入计划并落时间线", () => {
    const couple = repo.listCouples()[0];
    const plan = repo.createPlan(couple.id, "user-a", { title: "螺蛳粉之约", date: "2026-09-07", venueIds: ["venue-linjiejie-luosifen"] });
    repo.transitionPlan(plan.id, "user-a", "pending_confirmation");
    repo.transitionPlan(plan.id, "user-b", "confirmed");
    repo.transitionPlan(plan.id, "user-b", "completed");
    const review = repo.submitReview(plan.id, "user-a", { rating: 5, highlights: "夜市氛围很好", improvements: "" });
    expect(review.planId).toBe(plan.id);
    const events = repo.listTimeline(couple.id);
    expect(events.length).toBeGreaterThanOrEqual(3); // 创建计划/完成/复盘
  });

  it("里程碑提案：对方确认才生效", () => {
    const couple = repo.listCouples()[0];
    const proposal = repo.createProposal(couple.id, "user-a", "relationship", "这周末一起过了生日");
    expect(proposal.status).toBe("pending");
    expect(() => repo.respondProposal(proposal.id, "user-a", true)).toThrow();
    const done = repo.respondProposal(proposal.id, "user-b", true);
    expect(done.status).toBe("accepted");
  });
});
